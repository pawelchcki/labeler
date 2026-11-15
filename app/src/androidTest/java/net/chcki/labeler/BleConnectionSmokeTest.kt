package net.chcki.labeler

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/** Read-only hardware check: negotiate the real BLE connection and query status. No paper moves. */
class BleConnectionSmokeTest : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val result = Bundle()
        val transport = BleTransport(targetContext)
        try {
            val address = targetContext.getSharedPreferences("printer", 0).getString("address", null)
                ?: error("Select a printer in Labeler before running this check.")
            runBlocking {
                transport.connect(address)
                transport.execute(JSONArray().put(JSONObject()
                    .put("hex", "10ff40").put("wait", "status").put("delay", 0))) {}
            }
            result.putString("stream", "PASS: BLE connection, MTU negotiation and printer status query. No print sent.\n")
            finish(Activity.RESULT_OK, result)
        } catch (e: Exception) {
            result.putString("stream", "FAIL: ${e.stackTraceToString()}\n")
            finish(Activity.RESULT_CANCELED, result)
        } finally {
            transport.close()
        }
    }
}
