use std::io::{self,BufRead};
fn main(){for line in io::stdin().lock().lines(){println!("{}",action_printer_core::dispatch(&line.unwrap()));}}
