@file:Suppress("MissingPermission")
package net.chcki.labeler

import android.Manifest
import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.text.*
import android.view.View
import android.widget.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.util.UUID

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var text: EditText
    private lateinit var diameter: EditText
    private lateinit var length: EditText
    private lateinit var trim: EditText
    private lateinit var cable: Spinner
    private lateinit var mode: RadioGroup
    private lateinit var preview: ImageView
    private lateinit var advice: TextView
    private lateinit var status: TextView
    private lateinit var print: Button
    private lateinit var select: Button
    private var debounce: Job? = null
    private var activeScan: ScanCallback? = null
    private var plan: JSONObject? = null
    private var printing = false
    private var uncertain = false
    private val prefs by lazy { getSharedPreferences("printer", MODE_PRIVATE) }
    private val cableIds = listOf("cat6a","cat6","cat5e","hdmi","usb","usb-c","power","custom")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val content = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(24,40,24,32); setBackgroundColor(0xfff4f7f5.toInt()) }
        setContentView(ScrollView(this).apply { addView(content); fitsSystemWindows=true })
        fun caption(value:String,size:Float=16f) = TextView(this).apply { this.text=value; textSize=size; setPadding(0,12,0,12); content.addView(this) }
        caption("Labeler",30f); caption("Say it. Size it. Stick it.")
        status=caption("Choose a printer once. Everything stays on your phone.")
        select=Button(this).apply { this.text=prefs.getString("name","Choose printer"); setOnClickListener { discover() }; content.addView(this) }
        text=EditText(this).apply { hint="What should the label say?"; minLines=2; maxLines=5; content.addView(this) }
        mode=RadioGroup(this).apply { orientation=LinearLayout.HORIZONTAL; addView(RadioButton(this@MainActivity).apply { id=R.id.large_mode; this.text="Large label" }); addView(RadioButton(this@MainActivity).apply { id=R.id.wrap_mode; this.text="Cable wrap" }); check(R.id.large_mode); content.addView(this) }
        cable=Spinner(this).apply { adapter=ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf("Cat6a Ethernet · ~7.5 mm","Cat6 · ~6.2 mm","Cat5e · ~5.2 mm","HDMI · ~7 mm","USB · ~4 mm","USB-C · ~4.5 mm","Power · ~7 mm","Measured diameter")); content.addView(this) }
        diameter=EditText(this).apply { hint="Measured cable diameter (mm), optional"; inputType=8194; content.addView(this) }
        val details=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; visibility=View.GONE; content.addView(this) }
        val settings=Button(this).apply { this.text="Label size & alignment"; setOnClickListener { details.visibility=if(details.visibility==View.VISIBLE) View.GONE else View.VISIBLE } }
        content.addView(settings,content.indexOfChild(details))
        length=EditText(this).apply { hint="Stock length (mm)"; inputType=8194; setText(prefs.getFloat("length",30f).toString()); details.addView(this) }
        trim=EditText(this).apply { hint="End clearance / feed trim (mm)"; inputType=8194; setText(prefs.getFloat("trim",3f).toString()); details.addView(this) }
        details.addView(TextView(this).apply { this.text="Defaults match your 30 mm Fichero labels: 27 mm raster with 3 mm feed clearance. Change this if the print is clipped." })
        preview=ImageView(this).apply { adjustViewBounds=true; minimumHeight=190; setPadding(12,20,12,20); content.addView(this,LinearLayout.LayoutParams(-1,(150*resources.displayMetrics.density).toInt())) }
        advice=caption("Type a label to see the actual print layout.")
        print=Button(this).apply { this.text="Print one label"; isEnabled=false; setOnClickListener { send() }; content.addView(this) }
        Button(this).apply { this.text="Use with your assistant"; setOnClickListener { AlertDialog.Builder(this@MainActivity).setTitle("Printing with Gemini").setMessage("Choose a printer and allow Nearby devices here first. Once your Google account has access to Labeler, open Gemini, type @Labeler, and ask it to print your label. If it is missing, the integration still needs to be enabled for your Google account. You can always share text to Labeler to open a preview.").setPositiveButton("Got it",null).show() }; content.addView(this) }
        val watcher=object:TextWatcher { override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){}; override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){ refresh() }; override fun afterTextChanged(s:Editable?){} }
        listOf(text,diameter,length,trim).forEach { it.addTextChangedListener(watcher) }
        mode.setOnCheckedChangeListener { _,_-> refresh() }
        cable.onItemSelectedListener=object:AdapterView.OnItemSelectedListener { override fun onNothingSelected(p:AdapterView<*>?){}; override fun onItemSelected(p:AdapterView<*>?,v:View?,position:Int,id:Long){ refresh() } }
        accept(intent); refresh()
    }
    private fun accept(value:Intent) {
        val uri=value.data
        text.setText(if(value.action==Intent.ACTION_SEND) value.getStringExtra(Intent.EXTRA_TEXT) ?: "" else uri?.getQueryParameter("text") ?: "")
        if(uri?.getQueryParameter("mode")=="wrap") mode.check(R.id.wrap_mode)
        uri?.getQueryParameter("cable")?.let { val index=cableIds.indexOf(it); if(index>=0)cable.setSelection(index) }
        uri?.getQueryParameter("diameter_mm")?.let { diameter.setText(it) }
    }
    override fun onNewIntent(value:Intent) { super.onNewIntent(value); accept(value) }
    private fun request()=JSONObject().put("text",text.text.toString()).put("mode",if(mode.checkedRadioButtonId==R.id.wrap_mode) "wrap" else "large")
        .put("cable",cableIds[cable.selectedItemPosition.coerceAtLeast(0)]).put("diameter_mm",if(diameter.text.isBlank()) 0.0 else diameter.text.toString().toDouble())
        .put("length_mm",length.text.toString().toDouble()).put("trim_mm",trim.text.toString().toDouble())
    private fun refresh() {
        if(!::print.isInitialized)return
        val wrap=mode.checkedRadioButtonId==R.id.wrap_mode
        cable.visibility=if(wrap) View.VISIBLE else View.GONE; diameter.visibility=cable.visibility
        plan=null; print.isEnabled=false
        debounce?.cancel(); debounce=scope.launch {
            delay(180)
            try {
                val request=request()
                val result=withContext(Dispatchers.Default){NativeBridge.execute(request)}
                plan=result
                val bytes=result.getString("raster").bytes(); val rows=result.getInt("rows")
                val pixels=IntArray(96*rows) { if(bytes[it/8].toInt() and (0x80 shr (it%8)) !=0) 0xff000000.toInt() else 0xffffffff.toInt() }
                val bitmap=Bitmap.createBitmap(pixels,96,rows,Bitmap.Config.ARGB_8888)
                val matrix=android.graphics.Matrix().apply { if(!wrap) postRotate(90f) }
                preview.layoutParams=preview.layoutParams.apply { height=((if(wrap) 240 else 150)*resources.displayMetrics.density).toInt() }
                preview.contentDescription="Print preview: ${text.text}"
                preview.setImageDrawable(android.graphics.drawable.BitmapDrawable(resources,Bitmap.createBitmap(bitmap,0,0,96,rows,matrix,false)).apply { setFilterBitmap(false) })
                advice.text=(0 until result.getJSONArray("tips").length()).joinToString("\n\n") {result.getJSONArray("tips").getString(it)}
                print.isEnabled=!printing && !uncertain
            } catch(e:CancellationException) { throw e } catch(e:Exception) { preview.setImageDrawable(null); advice.text=if(text.text.isBlank()) "Type a label to preview it." else e.message ?: "Check the label settings." }
        }
    }
    private fun send() {
        val request=try {request()}catch(e:Exception){status.text="Check the label settings.";return}
        if(checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)!=PackageManager.PERMISSION_GRANTED || prefs.getString("address",null)==null){discover();return}
        printing=true; print.isEnabled=false; status.text="Connecting and printing…"
        prefs.edit().putFloat("length",request.getDouble("length_mm").toFloat()).putFloat("trim",request.getDouble("trim_mm").toFloat()).apply()
        scope.launch {
            try { PrintController.print(this@MainActivity,request,UUID.randomUUID().toString()); status.text="Printed. Ready for the next label." }
            catch(e:Exception){ status.text=e.message; if(e.message?.contains("may have started")==true){uncertain=true; AlertDialog.Builder(this@MainActivity).setTitle("Check the printed label").setMessage("The connection ended after printing may have started. Check the paper before printing again.").setPositiveButton("I've checked") {_,_->uncertain=false;refresh()}.show()} }
            finally {printing=false;refresh()}
        }
    }
    private fun discover() {
        if(checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)!=PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)!=PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_SCAN,Manifest.permission.BLUETOOTH_CONNECT),11); return
        }
        val adapter=getSystemService(BluetoothManager::class.java).adapter
        if(adapter==null || !adapter.isEnabled){status.text="Turn on Bluetooth, then tap Choose printer.";return}
        if(activeScan!=null)return
        val scanner=adapter.bluetoothLeScanner ?: run { status.text="Bluetooth scanner is unavailable. Turn Bluetooth off and on.";return }
        status.text="Looking for Fichero / D11s printers…"; select.isEnabled=false
        val devices=linkedMapOf<String,BluetoothDevice>()
        val cb=object:ScanCallback(){ override fun onScanResult(type:Int,result:ScanResult){val name=result.scanRecord?.deviceName ?: result.device.name ?: "";if(name.startsWith("FICHERO",true)||name.startsWith("D11s",true))devices[result.device.address]=result.device}
            override fun onScanFailed(errorCode:Int){status.text="Bluetooth scan failed ($errorCode). Try again."} }
        activeScan=cb; scanner.startScan(cb)
        scope.launch {delay(8000); scanner.stopScan(cb);activeScan=null;select.isEnabled=true
            if(devices.isEmpty()){status.text="No printer found. Switch it on nearby and close other printer apps.";return@launch}
            val found=devices.values.toList()
            AlertDialog.Builder(this@MainActivity).setTitle("Choose your printer").setItems(found.map {it.name ?: it.address}.toTypedArray()){_,index->
                val device=found[index]; prefs.edit().putString("address",device.address).putString("name",device.name ?: "Fichero").apply();select.text=device.name;status.text="Printer saved. Ready when you are."
            }.setNegativeButton("Cancel",null).show()
        }
    }
    override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray){super.onRequestPermissionsResult(code,permissions,results);if(code==11){if(results.isNotEmpty()&&results.all {it==PackageManager.PERMISSION_GRANTED})discover()else status.text="Allow Nearby devices to find and print to your label printer."}}
    override fun onDestroy(){activeScan?.let {runCatching {getSystemService(BluetoothManager::class.java).adapter?.bluetoothLeScanner?.stopScan(it)}};scope.cancel();super.onDestroy()}
}
