import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class RustProcess {
  constructor(example) {
    this.child = spawn(fileURLToPath(new URL(`../core/target/debug/examples/${example}`, import.meta.url)), [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.waiters = [];
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.waiters.shift();
      try { pending?.resolve(JSON.parse(line)); } catch (error) { pending?.reject(error); }
    });
    this.child.on('error', error => { for (const waiter of this.waiters.splice(0)) waiter.reject(error); });
    this.child.on('exit', code => { for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`Rust process exited: ${code}`)); });
  }
  call(input) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  }
  close() { this.child.kill(); }
}
