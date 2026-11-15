//! Deterministic D11s protocol model: no Bluetooth or physical paper is used.
//! Byte-stream parsing is independent of GATT packet boundaries.
use serde::Serialize;
use serde_json::{json,Value};
#[derive(Clone,Debug,Serialize,PartialEq,Eq)]
pub struct Page { pub rows:usize, pub raster:String, pub density:u8, pub paper:u8 }
#[derive(Default)]
pub struct Device {
    buffer:Vec<u8>, pub pages:Vec<Page>, pending:Option<Page>,
    density:u8, paper:u8, awake:bool, enabled:bool, awaiting_stop:bool,
    pub busy_after_stop:usize, pub reject_density:bool, pub fault:u8, pub busy_polls:usize, pub lose_stop_ack:bool,
    pub commands:Vec<String>, pub feeds:usize,
}
impl Device {
    pub fn snapshot(&self)->Value {json!({"pages":self.pages,"commands":self.commands,"feeds":self.feeds,"buffered":self.buffer.len(),"pending":self.pending,"enabled":self.enabled})}
    pub fn feed(&mut self,data:&[u8])->Result<Vec<Vec<u8>>,String>{
        self.buffer.extend_from_slice(data);let mut replies=vec![];
        loop {
            if self.buffer.is_empty(){break;}
            let b=&self.buffer;
            let needed=match b[0] {
                0=>12,
                0x10=>{if b.len()<3{break;}match b[2]{0x40|0x70|0x11|0x13=>3,0x84|0xfe=>4,0x10|0x12=>5,0x20|0x50=>4,_=>return Err("Unknown 10 FF opcode".into())}},
                0x1d=>{if b.len()<2{break;}match b[1]{0x0c=>2,0x76=>{
                    if b.len()<8{break;}
                    if b[..6]!=[0x1d,0x76,0x30,0,12,0]{return Err("Invalid raster header: require GS v 0, mode 0, 12 bytes per row".into());}
                    let rows=b[6] as usize+256*b[7] as usize;
                    if !(1..=480).contains(&rows){return Err("Raster rows out of range".into());}8+rows*12
                },_=>return Err("Unknown GS command".into())}},
                _=>return Err(format!("Unexpected command prefix {:02x}",b[0])),
            };
            if b.len()<needed{break;}
            let command:Vec<_>=self.buffer.drain(..needed).collect();
            self.commands.push(hex::encode(&command));
            let reply=match command.as_slice(){
                [0,0,0,0,0,0,0,0,0,0,0,0]=>{self.awake=true;None},
                [0x10,0xff,0x40]=>{let busy=if self.busy_polls>0{self.busy_polls-=1;1}else{0};Some(vec![self.fault|busy])},
                [0x10,0xff,0x10,0,n] if *n<=2=>{if self.reject_density{Some(b"ERR".to_vec())}else{self.density=*n;Some(b"OK".to_vec())}},
                [0x10,0xff,0x84,n] if *n<=2=>{self.paper=*n;Some(b"OK".to_vec())},
                [0x10,0xff,0xfe,1]=>{if !self.awake || self.busy_polls>0 || self.fault&0x56!=0 || self.awaiting_stop{return Err("Enable while asleep, faulted or previous job unfinished".into());}self.enabled=true;None},
                [0x1d,0x0c]=>{let page=self.pending.take().ok_or("Feed without exactly one complete raster")?;self.pages.push(page);self.feeds+=1;self.awaiting_stop=true;None},
                [0x10,0xff,0xfe,0x45]=>{if !self.awaiting_stop{return Err("Stop before form feed".into());}self.awaiting_stop=false;self.enabled=false;self.awake=false;self.busy_polls=self.busy_after_stop;if self.lose_stop_ack{None}else{Some(vec![0xaa])}},
                [0x10,0xff,0x20,0xf0]=>Some(b"D11s".to_vec()),
                [0x10,0xff,0x20,0xf1]=>Some(b"2.4.9".to_vec()),
                [0x10,0xff,0x20,0xf2]=>Some(b"EMULATED-D11S".to_vec()),
                [0x10,0xff,0x20,0xef]=>Some(b"V1.00".to_vec()),
                [0x10,0xff,0x50,0xf1]=>Some(vec![0,85]),
                [0x10,0xff,0x13]=>Some(vec![0,20]),
                bytes if bytes.starts_with(&[0x1d,0x76])=>{if !self.enabled||self.pending.is_some()||self.awaiting_stop{return Err("Raster outside a fresh enabled job".into());}
                    self.pending=Some(Page{rows:bytes[6] as usize+256*bytes[7] as usize,raster:hex::encode(&bytes[8..]),density:self.density,paper:self.paper});None},
                _=>return Err(format!("Malformed or unsupported command {}",hex::encode(command))),
            };
            if let Some(reply)=reply{replies.push(reply);}
        }
        Ok(replies)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn known_capture_and_stream_boundaries(){
        // Literal protocol vector, independent of the production protocol generator.
        let mut wire=hex::decode("10ff10000210ff840000000000000000000000000010fffe011d7630000c000100").unwrap();
        wire.extend([0x81;12]);wire.extend(hex::decode("1d0c10fffe45").unwrap());
        for chunk in [1,2,7,20,200,4096]{let mut device=Device::default();let mut replies=vec![];for part in wire.chunks(chunk){replies.extend(device.feed(part).unwrap());}assert_eq!(device.pages.len(),1);assert_eq!(device.pages[0].raster,"81".repeat(12));assert_eq!(device.feeds,1);assert_eq!(replies,vec![b"OK".to_vec(),b"OK".to_vec(),vec![0xaa]]);}
    }
    #[test] fn malformed_and_illegal_sequences(){let mut d=Device::default();assert!(d.feed(&[0x1d,0x0c]).is_err());let mut d=Device::default();assert!(d.feed(&[0x10,0xff,0xfe,1]).is_err());let mut d=Device::default();assert!(d.feed(&[0x1d,0x76,0x30,0,13,0,1,0]).is_err());}
    #[test] fn sensors_and_busy(){let mut d=Device{fault:4,busy_polls:1,..Default::default()};assert_eq!(d.feed(&[0x10,0xff,0x40]).unwrap(),vec![vec![5]]);assert_eq!(d.feed(&[0x10,0xff,0x40]).unwrap(),vec![vec![4]]);}
}
