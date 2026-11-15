@file:Suppress("MissingPermission", "DEPRECATION")
package net.chcki.labeler

import android.bluetooth.*
import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import java.util.UUID

/** Android GATT transport only. All commands and raster bytes originate in Rust. */
class BleTransport(private val context: Context) {
    private val connected = CompletableDeferred<Unit>()
    private val negotiatedMtu = CompletableDeferred<Int>()
    private val ready = CompletableDeferred<Unit>()
    private val writes = Channel<Int>(Channel.UNLIMITED)
    private val responses = Channel<ByteArray>(Channel.UNLIMITED)
    private var gatt: BluetoothGatt? = null
    private var writer: BluetoothGattCharacteristic? = null
    private var packetSize = 20
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                val error = IllegalStateException("Printer disconnected ($status). Turn it on and keep it nearby.")
                Log.w("LabelerBLE", "Connection ended: status=$status")
                connected.completeExceptionally(error); negotiatedMtu.completeExceptionally(error)
                ready.completeExceptionally(error); responses.close(error); writes.close(error)
            } else if (state == BluetoothProfile.STATE_CONNECTED) connected.complete(Unit)
        }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            Log.i("LabelerBLE", "MTU result: mtu=$mtu status=$status")
            negotiatedMtu.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23)
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val chars = g.services.flatMap { it.characteristics }
            writer = chars.firstOrNull { it.uuid.toString().startsWith("00002af1-") }
            val notify = chars.firstOrNull { it.uuid.toString().startsWith("00002af0-") }
            val descriptor = notify?.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
            if (status != 0 || writer == null || notify == null || descriptor == null) {
                ready.completeExceptionally(IllegalStateException("This device does not expose the D11s label service.")); return
            }
            g.setCharacteristicNotification(notify, true)
            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            if (!g.writeDescriptor(descriptor)) ready.completeExceptionally(IllegalStateException("Could not enable printer replies."))
        }
        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (status == 0) ready.complete(Unit) else ready.completeExceptionally(IllegalStateException("Printer notification setup failed."))
        }
        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) { writes.trySend(status) }
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) { if (Build.VERSION.SDK_INT < 33) responses.trySend(c.value.copyOf()) }
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) { responses.trySend(value.copyOf()) }
    }
    suspend fun connect(address: String) {
        val adapter = context.getSystemService(BluetoothManager::class.java).adapter
        check(adapter != null && adapter.isEnabled) { "Turn on Bluetooth first." }
        gatt = adapter.getRemoteDevice(address).connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        withTimeout(20000) { connected.await() }
        val g = requireNotNull(gatt)
        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        // Match the proven driver's 200-byte UART packets, within ATT's MTU - 3 limit.
        // Android 14+ may negotiate 517 regardless of the requested MTU; cap at 200.
        val mtu = if (g.requestMtu(203)) withTimeoutOrNull(3000) { negotiatedMtu.await() } ?: 23 else 23
        packetSize = (mtu - 3).coerceIn(20, 200)
        Log.i("LabelerBLE", "UART packet size=$packetSize")
        check(g.discoverServices()) { "Could not discover printer services." }
        withTimeout(20000) { ready.await() }
    }
    private suspend fun write(data: ByteArray) {
        val g = requireNotNull(gatt); val c = requireNotNull(writer)
        var sent = 0
        for (offset in data.indices step packetSize) {
            val chunk = data.copyOfRange(offset, minOf(offset + packetSize, data.size))
            c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            c.value = chunk
            check(g.writeCharacteristic(c)) { "Bluetooth is busy. Try again after checking the printer." }
            check(withTimeout(5000) { writes.receive() } == 0) { "Bluetooth write failed." }
            sent += chunk.size
            if (data.size > 200 && (sent % 400 == 0 || sent == data.size)) {
                Log.i("LabelerBLE", "Raster transfer: $sent/${data.size} bytes")
            }
            delay(20)
        }
    }
    private suspend fun query(data: ByteArray, timeout: Long): ByteArray {
        while (responses.tryReceive().isSuccess) { /* discard old replies before the command */ }
        write(data)
        val first = withTimeout(timeout) { responses.receive() }
        delay(60)
        var result = first
        while (true) { val next = responses.tryReceive().getOrNull() ?: break; result += next }
        return result
    }
    suspend fun execute(steps: org.json.JSONArray, started: () -> Unit) {
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i); val data = step.getString("hex").bytes()
            Log.i("LabelerBLE", "Step ${i + 1}/${steps.length()}: ${step.getString("wait")} bytes=${data.size}")
            when (step.getString("wait")) {
                "status" -> {
                    fun busy(response: ByteArray) = NativeBridge.execute(JSONObject().put("op","reply").put("mode","status").put("raster",response.joinToString(""){"%02x".format(it.toInt() and 255)})).getBoolean("busy")
                    var isBusy = busy(query(data,2500))
                    val deadline = System.currentTimeMillis()+30000
                    while(isBusy && System.currentTimeMillis()<deadline) { delay(500);isBusy=busy(query(data,2500)) }
                    check(!isBusy){"Printer is still busy."}
                }
                "ack", "complete" -> {
                    val phase=step.getString("wait")
                    val response=query(data,if(phase=="complete") 60000 else 2500)
                    NativeBridge.execute(JSONObject().put("op","reply").put("mode",phase).put("raster",response.joinToString(""){"%02x".format(it.toInt() and 255)}))
                }
                else -> { if (step.optBoolean("starts_print")) started(); write(data) }
            }
            delay(step.getLong("delay"))
        }
    }
    fun close() { gatt?.disconnect(); gatt?.close(); gatt = null }
}
