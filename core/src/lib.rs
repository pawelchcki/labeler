//! Offline label planning, font fitting, cable geometry and D11s wire protocol.
pub mod emulator;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use fontdue::{Font, FontSettings};
use std::f64::consts::PI;

const FONT: &[u8] = include_bytes!("../assets/NotoSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../assets/NotoSans-Bold.ttf");
const FONT_MONO: &[u8] = include_bytes!("../assets/NotoSansMono-Regular.ttf");
const FONT_SERIF: &[u8] = include_bytes!("../assets/NotoSerif-Regular.ttf");
#[derive(Deserialize)]
#[serde(default)]
pub struct Request {
    pub op: String, pub text: String, pub mode: String, pub cable: String,
    pub diameter_mm: f64, pub length_mm: f64, pub trim_mm: f64,
    pub copies: usize, pub raster: String, pub rows: usize, pub density: u8,
    pub font: String, pub font_size_px: usize, pub align: String,
}
impl Default for Request {
    fn default() -> Self { Self { op:"plan".into(), text:String::new(), mode:"large".into(), cable:"cat6a".into(), diameter_mm:0., length_mm:30., trim_mm:3., copies:1, raster:String::new(), rows:216, density:2, font:"sans".into(), font_size_px:0, align:"center".into() } }
}
#[derive(Clone, Serialize)]
pub struct Cable { pub id: &'static str, pub name: &'static str, pub diameter_mm:f64, pub range: &'static str }
pub fn cables() -> Vec<Cable> { vec![
    Cable{id:"cat6a",name:"Cat6a Ethernet",diameter_mm:7.5,range:"6–9 mm"},
    Cable{id:"cat6",name:"Cat6 Ethernet",diameter_mm:6.2,range:"5.5–7.5 mm"},
    Cable{id:"cat5e",name:"Cat5e Ethernet",diameter_mm:5.2,range:"4.5–6 mm"},
    Cable{id:"hdmi",name:"HDMI",diameter_mm:7.,range:"4–10 mm; especially variable"},
    Cable{id:"usb",name:"USB",diameter_mm:4.,range:"2.5–6 mm"},
    Cable{id:"usb-c",name:"USB-C charging",diameter_mm:4.5,range:"3–6 mm"},
    Cable{id:"power",name:"Power lead",diameter_mm:7.,range:"5–10 mm"},
    Cable{id:"custom",name:"Measured diameter",diameter_mm:6.,range:"enter measured diameter"},
] }
// Crop the actual glyph ink, including accents, rather than trusting advance widths.
fn line(font:&Font, text:&str, size:f32) -> (usize, usize, Vec<u8>) {
    let mut pen=0f32; let mut prev=None; let mut glyphs=vec![];
    let (mut x0,mut y0,mut x1,mut y1)=(i32::MAX,i32::MAX,i32::MIN,i32::MIN);
    for c in text.chars() {
        if let Some(p)=prev { pen+=font.horizontal_kern(p,c,size).unwrap_or(0.); }
        let (m,bitmap)=font.rasterize(c,size);
        let x=pen.round() as i32+m.xmin; let y=-m.ymin-m.height as i32;
        if m.width>0 && m.height>0 { x0=x0.min(x); y0=y0.min(y); x1=x1.max(x+m.width as i32); y1=y1.max(y+m.height as i32); }
        pen+=m.advance_width; prev=Some(c); glyphs.push((x,y,m,bitmap));
    }
    if x0==i32::MAX { return (1,1,vec![0]); }
    let (w,h)=((x1-x0) as usize,(y1-y0) as usize); let mut out=vec![0;w*h];
    for (x,y,m,b) in glyphs { for gy in 0..m.height { for gx in 0..m.width {
        let ox=(x-x0) as usize+gx; let oy=(y-y0) as usize+gy;
        if ox<w && oy<h { out[oy*w+ox]=out[oy*w+ox].max(b[gy*m.width+gx]); }
    } } }
    (w,h,out)
}
fn split(text:&str,count:usize)->Vec<String> {
    let words:Vec<_>=text.split_whitespace().collect();
    let mut lines=vec![String::new();count]; let mut index=0;
    let target=text.chars().count().div_ceil(count);
    for word in words { if index+1<count && !lines[index].is_empty() && lines[index].chars().count()+word.chars().count()+1>target {index+=1;}
        if !lines[index].is_empty(){lines[index].push(' ');} lines[index].push_str(word);
    }
    lines.into_iter().filter(|l|!l.is_empty()).collect()
}
fn aligned_offset(available:usize, used:usize, align:&str)->usize {
    match align { "left"=>0, "right"=>available-used, _=>(available-used)/2 }
}
fn fit(font:&Font,text:&str,w:usize,h:usize,requested_size:usize,align:&str)->Result<(usize,usize,Vec<u8>,usize),String> {
    let mut best=None;
    for count in 1..=4 { let lines=split(text,count);
        let sizes=if requested_size==0 {6..=160} else {requested_size..=requested_size};
        for size in sizes.rev() {
            let bits:Vec<_>=lines.iter().map(|l|line(font,l,size as f32)).collect();
            let width=bits.iter().map(|b|b.0).max().unwrap_or(0);
            let height=bits.iter().map(|b|b.1).sum::<usize>()+4*(bits.len()-1);
            if width<=w && height<=h {
                // Favor fewer lines when readability is otherwise comparable.
                let score=size*100-lines.len()*2;
                if best.as_ref().is_none_or(|(s,_)| score>*s) {
                    let mut pixels=vec![0;width*height]; let mut y=0;
                    for (bw,bh,bitmap) in bits { let x=aligned_offset(width,bw,align); for yy in 0..bh { pixels[(y+yy)*width+x..(y+yy)*width+x+bw].copy_from_slice(&bitmap[yy*bw..(yy+1)*bw]); } y+=bh+4; }
                    best=Some((score,(width,height,pixels,size)));
                } break;
            }
        }
    }
    best.map(|b|b.1).ok_or_else(|| if requested_size==0 {
        "Text is too long for a readable label. Shorten it or use longer stock.".into()
    } else { format!("Text does not fit at {} px. Choose Auto fit, a smaller size, or longer stock.",requested_size) })
}
fn paste(out:&mut[u8],width:usize,x:usize,y:usize,glyph:&(usize,usize,Vec<u8>,usize)) {
    for yy in 0..glyph.1 { for xx in 0..glyph.0 {out[(y+yy)*width+x+xx]=glyph.2[yy*glyph.0+xx];} }
}
pub fn plan(r:&Request)->Result<Value,String> {
    if r.text.trim().is_empty() || r.text.chars().count()>240 {return Err("Enter 1–240 characters.".into());}
    if !["large","wrap"].contains(&r.mode.as_str()) {return Err("Mode must be large or wrap.".into());}
    if !r.length_mm.is_finite() || !(15.0..=60.0).contains(&r.length_mm) || !r.trim_mm.is_finite() || !(0.0..=6.0).contains(&r.trim_mm) {return Err("Use 15–60 mm stock and 0–6 mm feed trim.".into());}
    if !(1..=10).contains(&r.copies) {return Err("Choose 1–10 copies.".into());}
    if !["left","center","right"].contains(&r.align.as_str()) {return Err("Alignment must be left, center or right.".into());}
    if r.font_size_px!=0 && !(6..=160).contains(&r.font_size_px) {return Err("Use Auto fit or a font size from 6–160 px.".into());}
    let font_bytes=match r.font.as_str() {
        "sans"=>FONT,"sans-bold"=>FONT_BOLD,"mono"=>FONT_MONO,"serif"=>FONT_SERIF,
        _=>return Err("Choose Sans, Sans bold, Mono or Serif.".into()),
    };
    let rows=((r.length_mm-r.trim_mm)*8.).floor() as usize;
    let font=Font::from_bytes(font_bytes,FontSettings::default()).map_err(|e|e.to_string())?;
    if r.text.chars().any(|c|!c.is_whitespace() && font.lookup_glyph_index(c)==0) {return Err("This font cannot print one of those characters. Use text without emoji or unsupported symbols.".into());}
    let mut pixels=vec![0;96*rows]; let mut tips=vec![]; let mut repeats=1; let mut diameter=0.; let size; let mut wrap=Value::Null;
    if r.mode=="large" {
        let g=fit(&font,&r.text,rows-12,84,r.font_size_px,&r.align)?; size=g.3;
        // Landscape text rotated 90 degrees into the physical 96-dot feed raster.
        let mut landscape=vec![0;rows*96]; paste(&mut landscape,rows,6+aligned_offset(rows-12,g.0,&r.align),(96-g.1)/2,&g);
        for y in 0..96 {for x in 0..rows {pixels[(rows-1-x)*96+y]=landscape[y*rows+x];}}
        tips.push("Peel and apply flat. Keep the calibrated end clearance.".to_string());
    } else {
        let preset=cables().into_iter().find(|c|c.id==r.cable).ok_or("Unknown cable preset. Choose a listed preset or custom.")?;
        diameter=if r.diameter_mm==0. {preset.diameter_mm}else{r.diameter_mm};
        if !diameter.is_finite() || !(2.0..=20.0).contains(&diameter) {return Err("Cable diameter must be 2–20 mm.".into());}
        let circumference=PI*diameter;
        wrap=json!({"circumference_mm":circumference,"minimum_length_mm":circumference+2.,"overlap_mm":r.length_mm-circumference,"fits":r.length_mm>=circumference+2.});
        if r.length_mm<circumference+2. {tips.push(format!("This cable needs at least {:.1} mm of stock for one turn plus 2 mm overlap. Use a longer label or a flag.",((circumference+2.)*10.).ceil()/10.));}
        if r.diameter_mm==0. {tips.push(format!("Diameter is an estimate ({})—measure the jacket for an exact fit.",preset.range));}
        // Two readable faces per turn, with enough spacing to avoid curvature hiding a whole block.
        let pitch=(circumference*8./2.).round().max(48.) as usize;
        repeats=(rows/pitch).clamp(2,4);
        let slot=(rows-12)/repeats; let max_h=slot.saturating_sub(10).min((circumference*8./3.) as usize).max(16);
        let g=fit(&font,&r.text,84,max_h,r.font_size_px,&r.align)?; size=g.3;
        for i in 0..repeats {let center=6+slot*i+slot/2; paste(&mut pixels,96,6+aligned_offset(84,g.0,&r.align),center-g.1/2,&g);}
        tips.push("Wrap the long edge around the jacket; the text reads along the cable. Keep the seam away from a complete copy.".into());
    }
    let gray:Vec<u8>=pixels.iter().map(|&p|255-p).collect();
    let raster=pack_pixels(&gray);
    Ok(json!({"ok":true,"width":96,"rows":rows,"raster":hex::encode(raster),"font_px":size,"font":r.font,"align":r.align,"auto_fit":r.font_size_px==0,"repeats":repeats,"diameter_mm":diameter,"wrap":wrap,"tips":tips}))
}
fn protocol(r:&Request)->Result<Value,String> {
    let data=hex::decode(&r.raster).map_err(|_|"Invalid raster")?;
    if !(72..=480).contains(&r.rows) || data.len()!=r.rows*12 || !(1..=10).contains(&r.copies) || r.density>2 {return Err("Invalid print dimensions, copies or density.".into());}
    let mut steps=vec![];
    for _ in 0..r.copies {
        steps.push(json!({"hex":"10ff40","wait":"status","delay":0}));
        steps.push(json!({"hex":format!("10ff1000{:02x}",r.density),"wait":"ack","delay":100}));
        steps.push(json!({"hex":"10ff8400","wait":"ack","delay":50}));
        steps.push(json!({"hex":"000000000000000000000000","wait":"none","delay":50}));
        steps.push(json!({"hex":"10fffe01","wait":"none","delay":50}));
        let mut bitmap=vec![0x1d,0x76,0x30,0,12,0,(r.rows&255) as u8,(r.rows>>8) as u8]; bitmap.extend(&data);
        steps.push(json!({"hex":hex::encode(bitmap),"wait":"none","delay":500,"starts_print":true}));
        steps.push(json!({"hex":"1d0c","wait":"none","delay":300}));
        steps.push(json!({"hex":"10fffe45","wait":"complete","delay":0}));
    }
    Ok(json!({"ok":true,"steps":steps}))
}
pub fn parse_reply(data:&[u8], phase:&str)->Result<Value,String> {
    match phase {
        "status" => {
            if data.len()!=1 { return Err("Unexpected status response. Reconnect and check the printer.".into()); }
            let status=data[0];
            if status&2!=0 {return Err("Close the printer cover.".into());}
            if status&4!=0 {return Err("Load the label roll.".into());}
            if status&0x50!=0 {return Err("Let the printhead cool down.".into());}
            Ok(json!({"ok":true,"busy":status&1!=0,"low_battery":status&8!=0}))
        },
        "ack" if data==b"OK" => Ok(json!({"ok":true})),
        "complete" if data.first()==Some(&0xaa) || data.starts_with(b"OK") => Ok(json!({"ok":true})),
        "ack" => Err("Printer did not acknowledge its settings.".into()),
        _ => Err("Completion is uncertain. Check the label before retrying.".into())
    }
}
fn pack_pixels(gray:&[u8])->Vec<u8>{
    let mut packed=vec![0u8;gray.len().div_ceil(8)];
    for (i,&value) in gray.iter().enumerate(){if value<128{packed[i/8]|=0x80>>(i%8);}}
    packed
}
fn pack_grayscale(r:&Request)->Result<Value,String>{
    let gray=hex::decode(&r.raster).map_err(|_|"Invalid grayscale input")?;
    if !(1..=480).contains(&r.rows)||gray.len()!=r.rows*96{return Err("Expected 96 pixels per row".into());}
    let packed=pack_pixels(&gray);
    Ok(json!({"ok":true,"raster":hex::encode(packed)}))
}
pub fn dispatch(input:&str)->String {
    let result=serde_json::from_str::<Request>(input).map_err(|e|e.to_string()).and_then(|r|match r.op.as_str(){
        "pack"=>pack_grayscale(&r),"plan"=>plan(&r),"protocol"=>protocol(&r),"reply"=>hex::decode(&r.raster).map_err(|_|"Invalid reply".into()).and_then(|b|parse_reply(&b,&r.mode)),"presets"=>Ok(json!({"ok":true,"cables":cables()})),_=>Err("Unknown operation".into())});
    match result {Ok(v)=>v.to_string(),Err(e)=>json!({"ok":false,"error":e}).to_string()}
}
// Small, dependency-free JSON ABI shared with the browser. Each allocation has
// exactly the length passed to free; responses carry a little-endian u32 length.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn labeler_alloc(len:usize)->*mut u8 {
    Box::into_raw(vec![0u8;len].into_boxed_slice()) as *mut u8
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub unsafe extern "C" fn labeler_free(ptr:*mut u8,len:usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr,len)));
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub unsafe extern "C" fn labeler_call(ptr:*const u8,len:usize)->*mut u8 {
    let input=std::str::from_utf8(std::slice::from_raw_parts(ptr,len)).unwrap_or("");
    let output=dispatch(input);
    let mut bytes=Vec::with_capacity(4+output.len());
    bytes.extend_from_slice(&(output.len() as u32).to_le_bytes());
    bytes.extend_from_slice(output.as_bytes());
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}
#[cfg(target_os="android")]
#[no_mangle]
pub extern "system" fn Java_net_chcki_labeler_NativeBridge_call(mut env:jni::JNIEnv,_class:jni::objects::JClass,input:jni::objects::JString)->jni::sys::jstring {
    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let input:String=env.get_string(&input).map_err(|e|e.to_string())?.into();
        Ok::<_,String>(dispatch(&input))
    })).unwrap_or_else(|_|Err("Label engine failed safely".into()));
    let output=result.unwrap_or_else(|e|json!({"ok":false,"error":e}).to_string());
    env.new_string(output).map(|s|s.into_raw()).unwrap_or(std::ptr::null_mut())
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn replies_validate_errors_and_busy(){assert_eq!(parse_reply(&[1],"status").unwrap()["busy"],true);assert!(parse_reply(&[4],"status").unwrap_err().contains("roll"));assert!(parse_reply(b"OK","status").is_err());assert!(parse_reply(&[0xaa],"complete").is_ok());assert!(parse_reply(b"NO","ack").is_err());}
 #[test] fn polish_is_not_clipped(){for text in ["mikuś 195m","garaż 1","kotłownia 2"] {let r=Request{text:text.into(),..Default::default()}; let p=plan(&r).unwrap();let bytes=hex::decode(p["raster"].as_str().unwrap()).unwrap();assert_eq!(bytes.len(),216*12);assert!(bytes.iter().any(|&b|b!=0)); assert!(bytes[..6*12].iter().all(|&b|b==0));assert!(bytes[210*12..].iter().all(|&b|b==0));}}
 #[test] fn wrap_geometry_and_overlap_tip(){let p=plan(&Request{text:"kamera wschód 2".into(),mode:"wrap".into(),diameter_mm:10.,..Default::default()}).unwrap();assert!(p["repeats"].as_u64().unwrap()>=2);assert!(p["tips"].to_string().contains("overlap"));}
 #[test] fn invalid_and_emoji_are_rejected(){for text in ["","😀"]{assert!(plan(&Request{text:text.into(),..Default::default()}).is_err());}assert!(plan(&Request{text:"x".into(),diameter_mm:f64::NAN,mode:"wrap".into(),..Default::default()}).is_err());}
 #[test] fn wire_protocol_dimensions_and_stop(){let p=plan(&Request{text:"hello".into(),..Default::default()}).unwrap();let r=Request{raster:p["raster"].as_str().unwrap().into(),..Default::default()};let v=protocol(&r).unwrap();let steps=v["steps"].as_array().unwrap();assert_eq!(steps.last().unwrap()["hex"],"10fffe45");let data=hex::decode(steps[5]["hex"].as_str().unwrap()).unwrap();assert_eq!(&data[..8],&[0x1d,0x76,0x30,0,12,0,216,0]);assert_eq!(data.len(),2600);}
 #[test] fn fonts_support_polish_and_produce_distinct_rasters(){
    let mut rasters=std::collections::HashSet::new();
    for font in ["sans","sans-bold","mono","serif"] {
        let p=plan(&Request{text:"garaż 1".into(),font:font.into(),font_size_px:24,..Default::default()}).unwrap();
        assert_eq!(p["font_px"],24); assert_eq!(p["auto_fit"],false);
        let raster=p["raster"].as_str().unwrap().to_string();
        assert!(rasters.insert(raster));
        assert!(plan(&Request{text:"mikuś".into(),font:font.into(),mode:"wrap".into(),font_size_px:12,..Default::default()}).is_ok());
    }
 }
 #[test] fn fixed_size_alignment_moves_ink_without_changing_it(){
    let mut edges=vec![]; let mut counts=vec![];
    for align in ["left","center","right"] {
        let p=plan(&Request{text:"ID 01".into(),font_size_px:24,align:align.into(),..Default::default()}).unwrap();
        let bytes=hex::decode(p["raster"].as_str().unwrap()).unwrap();
        let positions:Vec<_>=(0..216*96).filter(|&i|bytes[i/8]&(0x80>>(i%8))!=0).map(|i|215-i/96).collect();
        edges.push(*positions.iter().min().unwrap());counts.push(positions.len());
    }
    assert!(edges[0]<edges[1] && edges[1]<edges[2]);assert_eq!(counts[0],counts[1]);assert_eq!(counts[1],counts[2]);
 }
 #[test] fn invalid_font_configuration_and_oversized_text_are_rejected(){
    for r in [Request{font:"missing".into(),..Default::default()},Request{align:"up".into(),..Default::default()},Request{font_size_px:5,..Default::default()},Request{font_size_px:161,..Default::default()}] {
        assert!(plan(&Request{text:"x".into(),..r}).is_err());
    }
    let error=plan(&Request{text:"Does not fit".into(),font_size_px:160,..Default::default()}).unwrap_err();
    assert!(error.contains("160 px") && error.contains("Auto fit"));
 }
 #[test] fn wrap_metadata_reports_real_overlap_and_minimum_stock(){
    for (diameter,fits) in [(4.5,true),(7.5,true),(10.,false)] {
        let p=plan(&Request{text:"USB-C".into(),mode:"wrap".into(),diameter_mm:diameter,..Default::default()}).unwrap();
        let w=&p["wrap"];assert_eq!(w["fits"],fits);
        assert!((w["circumference_mm"].as_f64().unwrap()-PI*diameter).abs()<1e-9);
        assert!((w["minimum_length_mm"].as_f64().unwrap()-PI*diameter-2.).abs()<1e-9);
        assert!((w["overlap_mm"].as_f64().unwrap()+PI*diameter-30.).abs()<1e-9);
    }
 }
}
