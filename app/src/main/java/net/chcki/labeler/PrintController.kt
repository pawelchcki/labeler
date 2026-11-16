package net.chcki.labeler
import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

object PrintController {
    private val mutex = Mutex()
    suspend fun print(context: Context, request: JSONObject, requestId: String, onHealth: (JSONObject) -> Unit = {}): String = mutex.withLock {
        withContext(Dispatchers.IO) {
            require(requestId.length in 1..128) { "Provide a stable request ID (1–128 characters)." }
            val prefs = context.getSharedPreferences("printer", Context.MODE_PRIVATE)
            val key = "job:$requestId"
            prefs.getString(key, null)?.let { return@withContext it }
            val plan = NativeBridge.execute(request)
            val address = prefs.getString("address", null) ?: error("Open Labeler once and choose your printer.")
            val protocol = NativeBridge.execute(JSONObject().put("op", "protocol").put("raster", plan.getString("raster")).put("rows", plan.getInt("rows")).put("copies", request.optInt("copies", 1)))
            val transport = BleTransport(context.applicationContext,onHealth)
            var started = false
            try {
                transport.connect(address)
                transport.readDiagnostics()
                transport.execute(protocol.getJSONArray("steps")) {
                    started = true
                    check(prefs.edit().putString(key, "Completion uncertain. Check the physical label before using a new request ID.").commit())
                }
                val result = JSONObject().put("printed", true).put("text", request.getString("text")).put("copies", request.optInt("copies", 1)).put("diagnostics",transport.diagnostics()).put("tips", plan.getJSONArray("tips")).toString()
                prefs.edit().putString(key, result).commit()
                result
            } catch (e: Exception) {
                Log.e("LabelerBLE", "Print failed; rasterStarted=$started", e)
                if (started) error("Print may have started. Check the physical label before retrying. ${e.message}")
                throw e
            } finally { transport.close() }
        }
    }
}
