import React, { Component } from "react";
import { useEffect, useRef, useState } from "react";
import styled from 'styled-components';
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";
import GlobalStyle from "./GlobalStyles";
import { clientTools } from "./ClientTools";

const AppContainer = styled.div`
  height: 100%;
  width: 100%;
`;

const Nav = styled.nav`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4rem;
  display: flex;
  align-items: center;
`;

const NavContent = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  width: 100%;
  margin: 1rem;
  padding-bottom: 0.5rem;
  border: 0;
  border-bottom: 1px solid #e5e7eb;
`;

const Logo = styled.img`
  width: 24px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 1rem;
  font-weight: normal;
`;

/*
 * High-level layout
 * ┌──────────────────────────────┐
 * │            Nav              │
 * ├──────────────────────────────┤
 * │          Terminal            │  <- grows with its content
 * ├──────────────────────────────┤
 * │         Event Log            │  <- fills remaining space
 * ├──────────────────────────────┤
 * │      Session Controls        │  <- fixed height
 * └──────────────────────────────┘
 */

const Main = styled.main`
  position: absolute;
  top: 4rem;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
`;

const TerminalSection = styled.section`
  padding: 1rem;
  padding-top: 0;
  flex: 0 0 auto; /* let height be dictated by its content */
`;

const EventLogSection = styled.section`
  flex: 1 1 auto; /* take the remaining vertical space */
  padding: 0 1rem;
  overflow-y: auto;
`;

const SessionControlsSection = styled.section`
  flex: 0 0 8rem;
  padding: 1rem;
`;

// Define the session.update payload that registers the function tools with the model.
const SESSION_UPDATE_EVENT = {
  type: "session.update",
  session: {
    tools: clientTools,
    tool_choice: "auto",
  },
};

export default class App extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isSessionActive: false,
      events: [],
      dataChannel: null,
    };
    this.peerConnection = React.createRef();
    this.audioElement = React.createRef();
    this.audioContext = null; // iOS-only Web Audio pipeline
    this.startSession = this.startSession.bind(this);
    this.stopSession = this.stopSession.bind(this);
    this.sendClientEvent = this.sendClientEvent.bind(this);
    this.sendTextMessage = this.sendTextMessage.bind(this);
  }

  async startSession() {
    // Get a session token for OpenAI Realtime API
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    // Create a peer connection
    const pc = new RTCPeerConnection();

    // Set up to play remote audio from the model, routing to default or Bluetooth devices when possible
    const hiddenAudio = document.createElement("audio");
    hiddenAudio.autoplay = true;
    // playsInline avoids iOS fullscreen video UI and enables background/Bluetooth routing.
    hiddenAudio.playsInline = true;
    hiddenAudio.style.display = 'none';
    // Keep element in the DOM so Safari doesn't garbage-collect the MediaStream sink.
    document.body.appendChild(hiddenAudio);
    this.audioElement.current = hiddenAudio;
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      const audioEl = this.audioElement.current;
      // If browser supports selecting output device, route to the OS default
      if (typeof audioEl.setSinkId === 'function') {
        audioEl.srcObject = stream;
        // Kick-off playback; some browsers need an explicit invocation even with autoplay.
        const playPromise = audioEl.play();
        if (playPromise?.catch) {
          playPromise.catch(() => {/* user gesture may be required elsewhere */});
        }
        navigator.mediaDevices.enumerateDevices()
          .then(devices => {
            const def = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default');
            if (def) {
              audioEl.setSinkId(def.deviceId)
                .catch(err => console.warn('setSinkId error:', err));
            }
          })
          .catch(err => console.warn('enumerateDevices error:', err));
      // Fallback on browsers that do *not* support setSinkId (e.g. iOS Safari).
      // Using a plain <audio> element lets the OS keep the current route (Bluetooth / AirPlay / built-in)
      // whereas routing through the Web Audio API forces output to the speaker on iOS.
      } else {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;

        if (isIOS && AudioCtx) {
          try {
            const ctx = this.audioContext || (this.audioContext = new AudioCtx());
            if (ctx.state === 'suspended') {
              ctx.resume().catch(() => {/* ignore */});
            }
            const src = ctx.createMediaStreamSource(stream);
            src.connect(ctx.destination);
          } catch (err) {
            console.warn('Web-Audio fallback failed, reverting to media element:', err);
            audioEl.srcObject = stream;
            const p = audioEl.play();
            if (p?.catch) {
              p.catch(() => {/* ignored */});
            }
          }
        } else {
          audioEl.srcObject = stream;
          // Ensure playback starts – required on some browsers once mic is active.
          const p = audioEl.play();
          if (p?.catch) {
            p.catch(() => {/* ignored */});
          }
        }
      }
    };

    // Add local audio track for microphone input in the browser
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    pc.addTrack(ms.getTracks()[0]);

    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    this.setState({ dataChannel: dc });

    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    this.peerConnection.current = pc;

    // On iOS Safari the audio route can flip when the OS detects a new BT device.
    // If that happens, resuming the AudioContext immediately usually puts audio
    // back on the selected route.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream) {
      const resumeCtx = () => {
        if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {/* ignore */});
        }
      };
      navigator.mediaDevices?.addEventListener?.('devicechange', resumeCtx);
      document.addEventListener('visibilitychange', resumeCtx);
    }
  }

  // Stop current session, clean up peer connection and data channel
  stopSession() {
    const { dataChannel } = this.state;
    if (dataChannel) {
      dataChannel.close();
    }

    const peerConnection = this.peerConnection.current;
    if (peerConnection) {
      peerConnection.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.close();
    }

    this.setState({ isSessionActive: false, dataChannel: null });
    this.peerConnection.current = null;
  }

  // Send a message to the model
  sendClientEvent(message) {
    const { dataChannel } = this.state;
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      // send event before setting timestamp since the backend peer doesn't expect this field
      dataChannel.send(JSON.stringify(message));

      // if guard just in case the timestamp exists by miracle
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      this.setState((prevState) => ({ events: [message, ...prevState.events] }));
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Send a text message to the model
  sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    this.sendClientEvent(event);
    this.sendClientEvent({ type: "response.create" });
  }

  componentDidUpdate(prevProps, prevState) {
    const { dataChannel } = this.state;
    if (dataChannel && dataChannel !== prevState.dataChannel) {
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }
        this.setState((prevState) => ({ events: [event, ...prevState.events] }));
      });
      dataChannel.addEventListener("open", () => {
        this.setState({ isSessionActive: true, events: [] });
        // As soon as the channel is ready, register our tools with the model.
        this.sendClientEvent(SESSION_UPDATE_EVENT);
      });
    }
  }

  render() {
    const { isSessionActive, events } = this.state;
    return (
      <>
        <GlobalStyle />
        <AppContainer>
          <Nav>
            <NavContent>
              <Title>realtime console</Title>
            </NavContent>
          </Nav>
          <Main>
            <TerminalSection>
              <ToolPanel
                sendClientEvent={this.sendClientEvent}
                sendTextMessage={this.sendTextMessage}
                events={events}
                isSessionActive={isSessionActive}
              />
            </TerminalSection>
            <EventLogSection>
              <EventLog events={events} />
            </EventLogSection>
            <SessionControlsSection>
              <SessionControls
                startSession={this.startSession}
                stopSession={this.stopSession}
                sendClientEvent={this.sendClientEvent}
                sendTextMessage={this.sendTextMessage}
                events={events}
                isSessionActive={isSessionActive}
              />
            </SessionControlsSection>
          </Main>
        </AppContainer>
      </>
    );
  }
}
