import React, { useState } from "react";
import { CloudLightning, CloudOff, MessageSquare } from "react-feather";
import styled from 'styled-components';
import Button from "./Button";

const ControlsContainer = styled.div`
  display: flex;
  gap: 1rem;
  border-top: 2px solid #e5e7eb;
  height: 100%;
  border-radius: 0.375rem;
`;

const CenteredContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
`;

const ActiveContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 1rem;
`;

const MessageInput = styled.input`
  border: 1px solid #e5e7eb;
  border-radius: 9999px;
  padding: 1rem;
  flex: 1;
  outline: none;
  
  &:focus {
    border-color: #3b82f6;
  }
`;

const StartButton = styled(Button)`
  background-color: ${props => props.isActivating ? '#4b5563' : '#dc2626'};
`;

const SendButton = styled(Button)`
  background-color: #60a5fa;
`;

function SessionStopped({ startSession }) {
  const [isActivating, setIsActivating] = useState(false);

  function handleStartSession() {
    if (isActivating) return;

    setIsActivating(true);
    startSession();
  }

  return (
    <CenteredContainer>
      <StartButton
        onClick={handleStartSession}
        isActivating={isActivating}
        icon={<CloudLightning height={16} />}
      >
        {isActivating ? "starting session..." : "start session"}
      </StartButton>
    </CenteredContainer>
  );
}

function SessionActive({ stopSession, sendTextMessage }) {
  const [message, setMessage] = useState("");

  function handleSendClientEvent() {
    sendTextMessage(message);
    setMessage("");
  }

  return (
    <ActiveContainer>
      <MessageInput
        onKeyDown={(e) => {
          if (e.key === "Enter" && message.trim()) {
            handleSendClientEvent();
          }
        }}
        type="text"
        placeholder="send a text message..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <SendButton
        onClick={() => {
          if (message.trim()) {
            handleSendClientEvent();
          }
        }}
        icon={<MessageSquare height={16} />}
      >
        send text
      </SendButton>
      <Button onClick={stopSession} icon={<CloudOff height={16} />}>
        disconnect
      </Button>
    </ActiveContainer>
  );
}

export default function SessionControls({
  startSession,
  stopSession,
  sendClientEvent,
  sendTextMessage,
  serverEvents,
  isSessionActive,
}) {
  return (
    <ControlsContainer>
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendClientEvent={sendClientEvent}
          sendTextMessage={sendTextMessage}
          serverEvents={serverEvents}
        />
      ) : (
        <SessionStopped startSession={startSession} />
      )}
    </ControlsContainer>
  );
}
