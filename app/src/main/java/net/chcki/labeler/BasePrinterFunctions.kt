package net.chcki.labeler
import androidx.annotation.RequiresApi
import androidx.appfunctions.*
import org.json.JSONObject

/** Offline Fichero D11s label tools. Run previewLabel before printing when size or cable fit is uncertain. */
@RequiresApi(36)
@AppFunctionServiceEntryPoint(serviceName = "PrinterFunctions", appFunctionXmlFileName = "printer_functions")
abstract class BasePrinterFunctions : AppFunctionService() {
    /**
     * Plan a maximum-size label or repeated cable-wrap label and return fitting advice without printing.
     * @param text Exact label text; preserve spelling and accents. No emoji. Maximum 240 characters.
     * @param mode large for a flat label, wrap for text repeated around a cable.
     * @param cable One of cat6a, cat6, cat5e, hdmi, usb, usb-c, power, custom. Diameter presets are estimates.
     * @param diameterMm Measured jacket diameter, or zero to use the cable estimate.
     * @return JSON containing font size, repeat count, dimensions and placement tips. Does not consume paper.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun previewLabel(text: String, mode: String? = null, cable: String? = null, diameterMm: Double? = null): String =
        NativeBridge.execute(request(text, mode ?: "large", cable ?: "cat6a", diameterMm ?: 0.0, 1)).also { it.remove("raster") }.toString()

    /**
     * Print requested text on the configured Bluetooth Fichero/D11s printer. The user must have selected the printer and granted Bluetooth permissions in the app first.
     * @param text Exact user-requested text, including Polish accents. Do not invent or silently correct text.
     * @param requestId Stable unique identifier for this user printing request. Reuse the SAME identifier on retries to avoid duplicate physical labels. If completion is uncertain, ask the user to check output before creating a new request.
     * @param mode large to maximize flat label text, wrap to repeat readable text along a cable.
     * @param cable Cable preset: cat6a, cat6, cat5e, hdmi, usb, usb-c, power or custom.
     * @param diameterMm Measured cable diameter; zero uses an estimate. If fit advice says the stock is too short, suggest longer stock or a flag.
     * @param copies Number of physical labels, between one and ten; default one.
     * @return Printer acknowledgement and placement tips, or an error. Never claim the label physically fits until the user confirms.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun printLabel(text: String, requestId: String, mode: String? = null, cable: String? = null, diameterMm: Double? = null, copies: Int? = null): String {
        try { return PrintController.print(this, request(text, mode ?: "large", cable ?: "cat6a", diameterMm ?: 0.0, copies ?: 1), requestId) }
        catch (e: IllegalArgumentException) { throw AppFunctionInvalidArgumentException(e.message ?: "Invalid label") }
        catch (e: Exception) { throw AppFunctionAppUnknownException(e.message ?: "Printing failed") }
    }
    private fun request(text: String, mode: String, cable: String, diameter: Double, copies: Int): JSONObject {
        val prefs = getSharedPreferences("printer", MODE_PRIVATE)
        return JSONObject().put("text",text).put("mode",mode).put("cable",cable).put("diameter_mm",diameter).put("copies",copies)
            .put("length_mm",prefs.getFloat("length",30f).toDouble()).put("trim_mm",prefs.getFloat("trim",3f).toDouble())
    }
}
