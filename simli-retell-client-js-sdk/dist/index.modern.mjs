import { EventEmitter as t } from "eventemitter3";
import e from "isomorphic-ws";
class i extends t {
  constructor(t) {
    super(), (this.ws = void 0);
    let i =
      (t.customEndpoint || "wss://api.retellai.com/audio-websocket/") +
      t.callId;
    t.enableUpdate && (i += "?enable_update=true"),
      (this.ws = new e(i)),
      (this.ws.binaryType = "arraybuffer"),
      (this.ws.onopen = () => {
        this.emit("open");
      }),
      (this.ws.onmessage = (t) => {
        if ("string" == typeof t.data)
          if ("clear" === t.data) this.emit("clear");
          else
            try {
              const e = JSON.parse(t.data);
              this.emit("update", e);
            } catch (t) {
              this.emit("error", "Error parsing JSON update from server."),
                this.ws.close(1002, "Error parsing JSON update from server.");
            }
        else if (t.data instanceof ArrayBuffer) {
          const e = new Uint8Array(t.data);
          this.emit("audio", e);
        } else
          this.emit("error", "Got unknown message from server."),
            this.ws.close(1002, "Got unknown message from server.");
      }),
      (this.ws.onclose = (t) => {
        this.emit("close", t.code, t.reason);
      }),
      (this.ws.onerror = (t) => {
        this.emit("error", t.error);
      });
  }
  send(t) {
    1 === this.ws.readyState && this.ws.send(t);
  }
  close() {
    this.ws.close();
  }
}
class n extends t {
  constructor() {
    super(),
      (this.liveClient = void 0),
      (this.audioContext = void 0),
      (this.isCalling = !1),
      (this.stream = void 0),
      (this.audioNode = void 0);
  }
  async startConversation(t) {
    try {
      await this.setupAudio(t.sampleRate, t.customStream),
        (this.liveClient = new i({
          callId: t.callId,
          enableUpdate: t.enableUpdate,
        })),
        this.handleAudioEvents(),
        (this.isCalling = !0);
    } catch (t) {
      this.emit("error", t.message);
    }
  }
  stopConversation() {
    var t, e, i, n, s;
    (this.isCalling = !1),
      null == (t = this.liveClient) || t.close(),
      null == (e = this.audioContext) || e.suspend(),
      null == (i = this.audioNode) || i.disconnect(),
      delete this.audioNode,
      null == (n = this.audioContext) || n.close(),
      null == (s = this.stream) || s.getTracks().forEach((t) => t.stop()),
      delete this.liveClient,
      delete this.audioContext,
      delete this.stream;
  }
  async setupAudio(t, e) {
    this.audioContext = new AudioContext({ sampleRate: t });
    try {
      this.stream =
        e ||
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: t,
            echoCancellation: !0,
            noiseSuppression: !0,
            channelCount: 1,
          },
        }));
    } catch (t) {
      throw new Error("User didn't give microphone permission");
    }
    console.log("Audio worklet starting"), this.audioContext.resume();
    const i = new Blob(
        [
          '\nclass captureAndPlaybackProcessor extends AudioWorkletProcessor {\n    audioData = [];\n    index = 0;\n  \n    constructor() {\n      super();\n      //set listener to receive audio data, data is float32 array.\n      this.port.onmessage = (e) => {\n        if (e.data === "clear") {\n          // Clear all buffer.\n          this.audioData = [];\n          this.index = 0;\n        } else if (e.data.length > 0) {\n          this.audioData.push(this.convertUint8ToFloat32(e.data));\n        }\n      };\n    }\n  \n    convertUint8ToFloat32(array) {\n      const targetArray = new Float32Array(array.byteLength / 2);\n    \n      // A DataView is used to read our 16-bit little-endian samples out of the Uint8Array buffer\n      const sourceDataView = new DataView(array.buffer);\n    \n      // Loop through, get values, and divide by 32,768\n      for (let i = 0; i < targetArray.length; i++) {\n        targetArray[i] = sourceDataView.getInt16(i * 2, true) / Math.pow(2, 16 - 1);\n      }\n      return targetArray;\n    }\n  \n    convertFloat32ToUint8(array) {\n      const buffer = new ArrayBuffer(array.length * 2);\n      const view = new DataView(buffer);\n    \n      for (let i = 0; i < array.length; i++) {\n        const value = array[i] * 32768;\n        view.setInt16(i * 2, value, true); // true for little-endian\n      }\n    \n      return new Uint8Array(buffer);\n    }\n  \n    process(inputs, outputs, parameters) {\n      // Capture\n      const input = inputs[0];\n      const inputChannel1 = input[0];\n      this.port.postMessage(this.convertFloat32ToUint8(inputChannel1));\n  \n      // Playback\n      const output = outputs[0];\n      const outputChannel1 = output[0];\n      // start playback.\n      for (let i = 0; i < outputChannel1.length; ++i) {\n        if (this.audioData.length > 0) {\n          outputChannel1[i] = this.audioData[0][this.index];\n          this.index++;\n          if (this.index == this.audioData[0].length) {\n            this.audioData.shift();\n            this.index = 0;\n          }\n        } else {\n          outputChannel1[i] = 0;\n        }\n      }\n  \n      return true;\n    }\n  }\n  \n  registerProcessor(\n    "capture-and-playback-processor",\n    captureAndPlaybackProcessor,\n  );\n',
        ],
        { type: "application/javascript" }
      ),
      n = URL.createObjectURL(i);
    await this.audioContext.audioWorklet.addModule(n),
      console.log("Audio worklet loaded"),
      (this.audioNode = new AudioWorkletNode(
        this.audioContext,
        "capture-and-playback-processor"
      )),
      console.log("Audio worklet setup"),
      (this.audioNode.port.onmessage = (t) => {
        null != this.liveClient && this.liveClient.send(t.data);
      }),
      this.audioContext
        .createMediaStreamSource(this.stream)
        .connect(this.audioNode),
      this.audioNode.connect(this.audioContext.destination);
  }
  handleAudioEvents() {
    this.liveClient.on("open", () => {
      this.emit("conversationStarted");
    }),
      this.liveClient.on("audio", (t) => {
        this.audioNode.port.postMessage(t), this.emit("audio", t);
      }),
      this.liveClient.on("error", (t) => {
        this.emit("error", t), this.isCalling && this.stopConversation();
      }),
      this.liveClient.on("close", (t, e) => {
        this.isCalling && this.stopConversation(),
          this.emit("conversationEnded", { code: t, reason: e });
      }),
      this.liveClient.on("update", (t) => {
        this.emit("update", t);
      }),
      this.liveClient.on("clear", () => {
        this.audioNode.port.postMessage("clear");
      });
  }
}
export { n as RetellWebClient };
