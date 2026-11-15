package net.chcki.labeler
import org.json.JSONObject
object NativeBridge {
    init { System.loadLibrary("action_printer_core") }
    @JvmStatic external fun call(input: String): String
    fun execute(input: JSONObject): JSONObject = JSONObject(call(input.toString())).also {
        require(it.optBoolean("ok")) { it.optString("error", "Label engine failed") }
    }
}
fun String.bytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
