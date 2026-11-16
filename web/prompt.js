"use strict";
const readline = require("node:readline");

function askHiddenPin(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    // Redirected stdin is not echoed. Use readline's own prompt so it is not
    // erased by a second, empty prompt (the old Windows setup issue).
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output, terminal: false });
      let answered = false;
      rl.question(label, (value) => { answered = true; rl.close(); resolve(value.trim()); });
      rl.once("close", () => { if (!answered) reject(new Error("Input PIN dibatalkan.")); });
    });
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = !!input.isRaw;
    readline.emitKeypressEvents(input);
    output.write(label);
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const onEnd = () => { cleanup(); reject(new Error("Input PIN dibatalkan.")); };
    const onKey = (str, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) { cleanup(); reject(new Error("Setup PIN dibatalkan. Data transaksi tidak diubah.")); return; }
      if (["return", "enter"].includes(key.name)) { cleanup(); resolve(value); return; }
      if (["backspace", "delete"].includes(key.name)) {
        if (value.length) { value = value.slice(0, -1); output.write("\b \b"); }
        return;
      }
      if (typeof str === "string" && /^[0-9]$/.test(str) && value.length < 6) {
        value += str; output.write("*");
      }
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
  });
}
module.exports = { askHiddenPin };
