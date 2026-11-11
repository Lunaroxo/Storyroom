// Copies every raw input block to the page, untouched.
registerProcessor('rec', class extends AudioWorkletProcessor {
  process(inputs) {
    if (inputs[0].length) this.port.postMessage(inputs[0].map((channel) => channel.slice(0)));
    return true;
  }
});
