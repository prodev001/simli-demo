import React, {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";

import {moduleCode} from "./audioProcessor";

interface ImageFrame {
  frameWidth: number;
  frameHeight: number;
  imageData: Uint8Array;
}

interface props {
  // Start the stream
  start: boolean;

  // Session token for the video
  sessionToken: string;

  // Minimum chunk size for decoding,
  // Higher chunk size will result in longer delay but smoother playback
  // ( 1 chunk = 0.033 seconds )
  // ( 30 chunks = 0.99 seconds )
  minimumChunkSize?: number;
}

const SimliFaceStream = forwardRef(
  ({ start, sessionToken, minimumChunkSize = 8 }: props, ref) => {
    useImperativeHandle(ref, () => ({
      sendAudioDataToLipsync,
    }));
    SimliFaceStream.displayName = "SimliFaceStream";

    const ws = useRef<WebSocket | null>(null); // WebSocket connection for audio data

    const startTime = useRef<any>();
    const executionTime = useRef<any>();

    const numberOfChunksInQue = useRef<number>(0); // Number of buffered chunks in queue waiting to be decoded

    const startTimeFirstByte = useRef<any>(null);
    const timeTillFirstByte = useRef<any>(null);

    // ------------------- AUDIO -------------------
    const audioContext = useRef<AudioContext | null>(null); // Ref for audio context
    const audioNode = useRef<AudioWorkletNode | null>(null); // Ref for audio node
    const audioQueue = useRef<Array<AudioBuffer>>([]); // Ref for audio queue

    const accumulatedAudioBuffer = useRef<Uint8Array>(null); // Buffer for accumulating incoming data until it reaches the minimum size for decoding

    const playbackDelay = minimumChunkSize * (1000 / 30); // Playback delay for audio and video in milliseconds

    const callCheckAndPlayFromQueueOnce = useRef<boolean>(true);
    const audioQueueEmpty = useRef<boolean>(false);

    // ------------------- VIDEO -------------------
    const frameQueue = useRef<Array<Array<ImageFrame>>>([]); // Queue for storing video data

    const accumulatedFrameBuffer = useRef<Array<ImageFrame>>([]); // Buffer for accumulating incoming video data
    const currentFrameBuffer = useRef<Array<ImageFrame>>([]); // Buffer for accumulating incoming video data
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [videoContext, setVideoContext] =
      useState<CanvasRenderingContext2D | null>(null);
    const currentFrame = useRef(0);

    const fps = 30;
    const frameInterval = 30; // Calculate the time between frames in milliseconds

    /* Create AudioContext at the start */
    useEffect(() => {
      // Return if start is false
      if (start === false) return;

      // Initialize AudioContext
      loadAudioWorklet();

      // Intialize VideoContext
      const videoCanvas = canvasRef.current;
      if (videoCanvas) {
        setVideoContext(videoCanvas?.getContext("2d"));
        console.log("VideoContext created");
      }
    }, [start]);

    const sendAudioDataToLipsync = (audioData: Uint8Array) => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(audioData);
        startTimeFirstByte.current = performance.now(); // Start time for first byte
      }
    };

    const loadAudioWorklet = async () => {
      try {
        const newAudioContext = new AudioContext({sampleRate: 16000});
        const blob = new Blob([moduleCode], { type: "application/javascript" });
        const blobURL = URL.createObjectURL(blob);
        await newAudioContext.audioWorklet.addModule(blobURL);
        const newAudioNode = new AudioWorkletNode(newAudioContext, 'pcm-player');
        newAudioNode.connect(newAudioContext.destination);
    
        audioContext.current = newAudioContext;
        audioNode.current = newAudioNode;
        console.log("AudioContext created");
      } catch (error) {
        console.error("Error loading AudioWorklet module:", error);
      }
    };

    /* Process Data Bytes to Audio and Video */
    const processToVideoAudio = async (dataArrayBuffer: ArrayBuffer) => {
      let data = new Uint8Array(dataArrayBuffer);

      // --------------- WEBSOCKET SCHEMA ----------------
      // READ MORE: https://github.com/simliai/simli-next-js-demo/blob/main/Websockets.md

      // 5 bytes for VIDEO message
      const start_VIDEO = 0;
      const end_VIDEO = 5;

      // 4 bytes for total number of video bytes
      const start_numberOfVideoBytes = end_VIDEO;
      const end_numberOfVideoBytes = start_numberOfVideoBytes + 4;
      const numberOfVideoBytes = new DataView(
        data.buffer.slice(start_numberOfVideoBytes, end_numberOfVideoBytes)
      ).getUint32(0, true);

      // 4 bytes for frame index
      const start_frameIndex = end_numberOfVideoBytes;
      const end_frameIndex = start_frameIndex + 4;

      // 4 bytes for frame width
      const start_frameWidth = end_frameIndex;
      const end_frameWidth = start_frameWidth + 4;

      // 4 bytes for frame height
      const start_frameHeight = end_frameWidth;
      const end_frameHeight = start_frameHeight + 4;

      // v bytes for video data
      const start_imageData = end_frameHeight;
      const end_imageData = 9 + numberOfVideoBytes; // we add 9 since we have 4+4+4=9 bytes before the image data

      // 5 bytes for AUDIO message
      const start_AUDIO = end_imageData;
      const end_AUDIO = start_AUDIO + 5;

      // 4 bytes for total number of audio bytes
      const start_numberOfAudioBytes = end_AUDIO;
      const end_numberOfAudioBytes = start_numberOfAudioBytes + 4;
      const numberOfAudioBytes = new DataView(
        data.buffer.slice(start_numberOfAudioBytes, end_numberOfAudioBytes)
      ).getUint32(0, true);

      // a bytes for audio data
      const start_audioData = end_numberOfAudioBytes;
      const end_audioData = start_audioData + numberOfAudioBytes;

      // --------------- VIDEO DATA ----------------

      // For debugging: this should return "VIDEO"
      const videoMessage = new TextDecoder().decode(
        data.slice(start_VIDEO, end_VIDEO)
      );

      const frameWidth = new DataView(
        data.buffer.slice(start_frameWidth, end_frameWidth)
      ).getUint32(0, true);

      const frameHeight = new DataView(
        data.buffer.slice(start_frameHeight, end_frameHeight)
      ).getUint32(0, true);

      const imageData = data.subarray(start_imageData, end_imageData); // The rest is image data

      // Push image data to frame queue
      const imageFrame: ImageFrame = { frameWidth, frameHeight, imageData };

      // --------------- AUDIO DATA ----------------

      // For debugging: this should return "AUDIO"
      const audioMessage = new TextDecoder().decode(
        data.slice(start_AUDIO, end_AUDIO)
      );

      // Extract Audio data
      const audioData = data.subarray(start_audioData, end_audioData);

      // --------------- Update Audio and Video Queue ---------------
      updateAudioAndVideoQueue(audioData, imageFrame);

      // --------------- LOGGING ----------------

      // console.log(
      //   "VIDEO: ", start_VIDEO, end_VIDEO, "\n",
      //   "numberOfVideoBytes: ", start_numberOfVideoBytes, end_numberOfVideoBytes, "=", numberOfVideoBytes, "\n",
      //   "frameIndex: ", start_frameIndex, end_frameIndex, "\n",
      //   "frameWidth: ", start_frameWidth, end_frameWidth, "\n",
      //   "frameHeight: ", start_frameHeight, end_frameHeight, "\n",
      //   "imageData: ", start_imageData, end_imageData, "\n",
      //   "AUDIO: ", start_AUDIO, end_AUDIO, "\n",
      //   "numberOfAudioBytes: ", start_numberOfAudioBytes, end_numberOfAudioBytes, "=", numberOfAudioBytes, "\n",
      //   "audioData: ", start_audioData, end_audioData
      // );

      // console.log(
      //   `${videoMessage}: ${imageData.byteLength}\n` +
      //     `${audioMessage}: ${audioData.byteLength}\n`
      // );

      // console.warn("");
    };

    /* Connect with Lipsync stream */
    useEffect(() => {
      // Return if start is false
      if (start === false) return;

      const ws_lipsync = new WebSocket("wss://api.simli.ai/LipsyncStream");
      ws_lipsync.binaryType = "arraybuffer";
      ws.current = ws_lipsync;

      ws_lipsync.onopen = () => {
        console.log("Connected to lipsync server");
        ws_lipsync.send(sessionToken);
      };

      ws_lipsync.onmessage = (event) => {
        if (startTime.current === null) {
          startTime.current = performance.now();
        }

        // console.log("Received data arraybuffer from lipsync server:", event.data);
        console.log("Received chunk from Lipsync");
        processToVideoAudio(event.data);

        numberOfChunksInQue.current += 1; // Increment chunk size by 1

        return () => {
          if (ws.current) {
            console.error("Closing Lipsync WebSocket");
            ws.current.close();
          }
        };
      };

      return () => {
        console.error("Closing Lipsync WebSocket");
        ws_lipsync.close();
      };
    }, [
      audioContext,
      start,
      // NOTE: these should likely be in the dependency array too
      sessionToken,
      processToVideoAudio,
    ]);

    /* Play video frames queue */
    const playFrameQueue = async () => {
      // Update current frame buffer if there is a new frame
      const frame: ImageFrame[] | undefined = frameQueue.current.shift();
      if (frame !== undefined) {
        currentFrameBuffer.current = frame;
      }

      const drawFrame = async () => {
        if (currentFrame.current >= currentFrameBuffer.current.length) {
          currentFrame.current = 0;
          return;
        }

        const arrayBuffer =
          currentFrameBuffer.current[currentFrame.current].imageData;
        const width =
          currentFrameBuffer.current[currentFrame.current].frameWidth;
        const height =
          currentFrameBuffer.current[currentFrame.current].frameHeight;

        const blob = new Blob([arrayBuffer]); // Convert ArrayBuffer to Blob
        const url = URL.createObjectURL(blob);

        const image = new Image();
        image.onload = () => {
          videoContext?.clearRect(0, 0, width, height);
          videoContext?.drawImage(image, 0, 0, width, height);
          URL.revokeObjectURL(url); // Clean up memory after drawing the image
        };
        image.src = url;

        currentFrame.current++;
        setTimeout(drawFrame, frameInterval); // Set the next frame draw
      };

      await drawFrame();
    };

    const updateAudioAndVideoQueue = async (audioData: Uint8Array ,imageFrame: ImageFrame) => {
      if (numberOfChunksInQue.current >= minimumChunkSize) {
        // Update Audio Queue
        console.log("Sending audio to AudioWorkletNode:", accumulatedAudioBuffer.current);
        audioNode.current.port.postMessage(accumulatedAudioBuffer.current);
        accumulatedAudioBuffer.current = null;

        // Update Frame Queue
        frameQueue.current.push(accumulatedFrameBuffer.current);
        accumulatedFrameBuffer.current = [];
        playFrameQueue();

        // Reset chunk size
        numberOfChunksInQue.current = 0; 
      } else {
        // Update Audio Buffer
        if (!accumulatedAudioBuffer.current) {
          accumulatedAudioBuffer.current = audioData;
        } else {
          const combinedUint8Array = new Uint8Array(
            accumulatedAudioBuffer.current.length + audioData.length
          );
          combinedUint8Array.set(accumulatedAudioBuffer.current, 0);
          combinedUint8Array.set(audioData, accumulatedAudioBuffer.current.length);
          accumulatedAudioBuffer.current = combinedUint8Array;
        }

        // Update Frame Buffer
        accumulatedFrameBuffer.current.push(imageFrame);
      }
    };

    const sendSilence = () => {
      const silence = new Uint8Array(1068 * minimumChunkSize);
      ws.current?.send(silence);
      console.log("Sending silence!");
    };

    return <canvas ref={canvasRef} width="512" height="512"></canvas>;
  }
);

export default SimliFaceStream;
