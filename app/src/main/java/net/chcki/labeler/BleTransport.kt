@file:Suppress("MissingPermission", "DEPRECATION")
package net.chcki.labeler

import android.bluetooth.*
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import java.util.UUID

/** Android GATT transport only. All commands and raster bytes originate in Rust. */
class BleTransport(private val context: Context, private val onHealth: (JSONObject) -> Unit = {}) {
    private val lock = Any()
    @Volatile private var live = false
    @Volatile private var executing = false
    @Volatile private var queryActive = false
    @Volatile private var jobError: String? = null
    @Volatile private var fault = ""
    @Volatile private var discardUntil = 0L
    private var pendingReport = ""
    private var txBytes = 0L; private var rxBytes = 0L; private var packets = 0L
    private var writeMs = 0L; private var maxWriteMs = 0L; private var replyMs = 0L
    private var timeouts = 0; private var faults = 0; private var discards = 0
    private var transferBytes = 0; private var transferMs = 0L
    private var pacingMs = 20L
    private val identity = JSONObject()
    private val events = java.util.ArrayDeque<JSONObject>()
    fun diagnostics(): JSONObject = synchronized(lock) {
        JSONObject().put("identity", JSONObject(identity.toString())).put("tx_bytes",txBytes).put("rx_bytes",rxBytes)
            .put("packets",packets).put("packet_size",packetSize).put("pacing_ms",pacingMs)
            .put("write_avg_ms",if(packets>0)writeMs.toDouble()/packets else 0.0).put("write_max_ms",maxWriteMs)
            .put("reply_ms",replyMs).put("timeouts",timeouts).put("faults",faults).put("discard_reports",discards)
            .put("bytes_per_second",if(transferMs>0)transferBytes*1000.0/transferMs else 0.0)
            .put("fault",fault).put("discarding",SystemClock.elapsedRealtime()<discardUntil)
            .put("events",org.json.JSONArray(events.toList())).put("note","Host writes do not prove printer delivery. Label data is not logged.")
    }
    private fun publish() { onHealth(diagnostics()) }
    private fun record(kind:String, message:String) = synchronized(lock) {
        events.add(JSONObject().put("at",System.currentTimeMillis()).put("kind",kind).put("message",message))
        while(events.size>100)events.removeFirst()
    }
    private fun receive(value:ByteArray) {
        synchronized(lock) {
            rxBytes += value.size
            val result=NativeBridge.execute(JSONObject().put("op","reports").put("raster",pendingReport+value.hex()))
            pendingReport=result.getString("pending")
            val reports=result.getJSONArray("events")
            for(i in 0 until reports.length()) {
                val event=reports.getJSONObject(i); record(event.getString("kind"),event.toString())
                if(event.getString("kind")=="fault") {
                    fault=event.getString("message")
                    if(event.getInt("code")!=0) {faults++;if(executing && jobError==null)jobError=fault}
                } else {
                    discards++;discardUntil=if(event.getBoolean("active"))SystemClock.elapsedRealtime()+60000 else 0
                    if(event.getBoolean("active") && executing && jobError==null)jobError="Printer is discarding incoming data. Wait or reconnect."
                }
            }
            val reply=result.getString("reply")
            if(queryActive && reply.isNotEmpty())responses.trySend(reply.bytes())
        }
        publish()
    }
    private fun healthy(allowFault:Boolean=false) {
        check(live) { "Printer disconnected. Check the physical label before retrying." }
        jobError?.let { error(it) }
        check(SystemClock.elapsedRealtime()>=discardUntil) { "Printer is discarding data. Wait up to 60 seconds or reconnect." }
        if(!allowFault)check(fault.isEmpty()) {fault}
        synchronized(lock) {check(pendingReport.isEmpty()) {"Incomplete printer report. Reconnect before sending more data."}}
    }
    private fun ByteArray.hex()=joinToString(""){"%02x".format(it.toInt() and 255)}
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
                live=false;jobError=error.message;record("disconnect",error.message ?: "Disconnected");publish()
                connected.completeExceptionally(error); negotiatedMtu.completeExceptionally(error)
                ready.completeExceptionally(error); responses.close(error); writes.close(error)
            } else if (state == BluetoothProfile.STATE_CONNECTED) {live=true;connected.complete(Unit)}
        }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            Log.i("LabelerBLE", "MTU result: mtu=$mtu status=$status")
            negotiatedMtu.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23)
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val chars = g.getService(UUID.fromString("000018f0-0000-1000-8000-00805f9b34fb"))?.characteristics ?: emptyList()
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
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) { if (Build.VERSION.SDK_INT < 33 && c.uuid.toString().startsWith("00002af0-")) runCatching { receive(c.value.copyOf()) }.onFailure { jobError=it.message;responses.close(it) } }
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) { if(c.uuid.toString().startsWith("00002af0-")) runCatching { receive(value.copyOf()) }.onFailure {jobError=it.message;responses.close(it)} }
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
        val model=query("10ff20f0".bytes(),2500).toString(Charsets.US_ASCII).trim().trimEnd('\u0000')
        check(model.equals("D11s",true)) { "Unsupported printer model: $model. Labeler requires D11s." }
        synchronized(lock) {identity.put("model",model)}
        publish()
    }
    private suspend fun write(data: ByteArray, allowFault:Boolean=false) {
        val g = requireNotNull(gatt); val c = requireNotNull(writer)
        var sent=0;val began=SystemClock.elapsedRealtime()
        for(offset in data.indices step packetSize) {
            // Reports are framed synchronously by the shared Rust engine in the callback.
            if(synchronized(lock){pendingReport.isNotEmpty()})delay(60)
            healthy(allowFault)
            val chunk=data.copyOfRange(offset,minOf(offset+packetSize,data.size))
            c.writeType=BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;c.value=chunk
            val before=SystemClock.elapsedRealtime()
            check(g.writeCharacteristic(c)) { "Bluetooth is busy. Check the printer before retrying." }
            val status=try {withTimeout(5000){writes.receive()}}catch(e:TimeoutCancellationException){synchronized(lock){timeouts++};publish();throw IllegalStateException("Bluetooth write stalled. Check the physical label.",e)}
            check(status==0) { "Bluetooth write failed ($status)." }
            val elapsed=SystemClock.elapsedRealtime()-before
            synchronized(lock) {txBytes+=chunk.size;packets++;writeMs+=elapsed;maxWriteMs=maxOf(maxWriteMs,elapsed);if(elapsed>100)pacingMs=minOf(80,pacingMs+10)}
            if(synchronized(lock){pendingReport.isNotEmpty()})delay(60)
            healthy(allowFault);sent+=chunk.size
            delay(pacingMs)
            if(data.size>200)synchronized(lock){transferBytes=sent;transferMs=SystemClock.elapsedRealtime()-began}
            publish()
        }
    }
    private suspend fun query(data: ByteArray, timeout: Long): ByteArray {
        synchronized(lock) {
            check(!queryActive){"Printer query already active."}
            while(responses.tryReceive().isSuccess) { /* Reply bytes only; report state is never discarded. */ }
            queryActive=true
        }
        val began=SystemClock.elapsedRealtime();record("query",data.hex())
        try {
            write(data,true)
            var result=try {withTimeout(timeout){responses.receive()}}catch(e:TimeoutCancellationException){synchronized(lock){timeouts++};throw IllegalStateException("No reply from the printer. Check power, paper and cover.",e)}
            // Allow split ASCII replies and reports to finish; never let a trailing
            // fault become part of an otherwise successful acknowledgement.
            while(true) {
                val next=withTimeoutOrNull(60){responses.receive()} ?: break
                result+=next;check(result.size<=4096){"Printer reply exceeds receive limit."}
            }
            if(synchronized(lock){pendingReport.isNotEmpty()})delay(60)
            healthy(true);synchronized(lock){replyMs=SystemClock.elapsedRealtime()-began}
            return result
        } finally {queryActive=false;publish()}
    }
    suspend fun readDiagnostics() {
        check(!executing){"Wait for printing to finish."}
        for((key,command) in listOf("version" to "10ff20f1","boot" to "10ff20ef")) {
            val text=query(command.bytes(),2500).toString(Charsets.US_ASCII).trim().trimEnd('\u0000')
            synchronized(lock){identity.put(key,text)}
        }
        val battery=query("10ff50f1".bytes(),2500)
        check(battery.size==2 && (battery[1].toInt() and 255)<=100){"Invalid printer battery response."}
        synchronized(lock){identity.put("battery",battery[1].toInt() and 255).put("battery_raw",battery.hex())}
        publish()
    }
    suspend fun execute(steps: org.json.JSONArray, started: () -> Unit) {
        check(!executing){"A label is already printing."};executing=true;jobError=null
        try {
            for(i in 0 until steps.length()) {
                val step=steps.getJSONObject(i);val data=step.getString("hex").bytes()
                when(val phase=step.getString("wait")) {
                    "status" -> {
                        val end=SystemClock.elapsedRealtime()+30000
                        while(true) {
                            val result=NativeBridge.execute(JSONObject().put("op","reply").put("mode","status").put("raster",query(data,2500).hex()))
                            check(!result.optBoolean("low_battery")){"Charge the printer before printing."}
                            fault=""
                            if(!result.getBoolean("busy"))break
                            check(SystemClock.elapsedRealtime()<end){"Printer is still busy."};delay(500)
                        }
                    }
                    "ack","complete" -> NativeBridge.execute(JSONObject().put("op","reply").put("mode",phase).put("raster",query(data,if(phase=="complete")60000 else 2500).hex()))
                    else -> {healthy();if(step.optBoolean("starts_print"))started();write(data)}
                }
                delay(step.getLong("delay"));healthy()
            }
        } catch(e:Exception){record("error",e.message ?: "Print failed");throw e}
        finally {executing=false;publish()}
    }
    fun close() { live=false;gatt?.disconnect();gatt?.close();gatt=null }
}
