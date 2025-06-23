import React, { useEffect, useState } from "react";
import styled from 'styled-components';
import axios from 'axios';

const PanelContainer = styled.section`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const ContentContainer = styled.div`
  background-color: #f9fafb;
  border-radius: 0.375rem;
  padding: 1rem;
`;

const OutputContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  position: relative;
`;

const OutputSection = styled.div`
  width: 100%;
`;

const SectionTitle = styled.h2`
  font-size: 1.125rem;
  font-weight: bold;
  margin: 0 0 0.5rem 0;
`;

const CodeBlock = styled.pre`
  font-size: 0.75rem;
  background-color: #000000;
  color: #ffffff;
  border-radius: 0.375rem;
  padding: 0.5rem;
  width: 100%;
  white-space: pre;
  overflow: auto;
  margin: 0;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  position: relative;

  /* Flash the background when loading */
  ${props => props.$isLoading && `
    animation: flash-bg 1s step-start infinite;
    @keyframes flash-bg {
      0%, 100% { background-color: #000000; }
      50% { background-color: #013220; }
    }
  `}
`;

const StatusText = styled.p`
  margin: 0;
`;

const ConnectionStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
`;

const StatusIndicator = styled.div`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: ${props => props.$connected ? '#10b981' : '#ef4444'};
`;

function TerminalOutput({ terminalState, isProcessing }) {
  return (
    <OutputContainer>
      <OutputSection>
        {terminalState && (
          <>
            <SectionTitle>Terminal State</SectionTitle>
            <CodeBlock $isLoading={isProcessing}>{terminalState}</CodeBlock>
          </>
        )}
      </OutputSection>
    </OutputContainer>
  );
}

let busyMap = {};

export default function ToolPanel({
  isSessionActive,
  sendClientEvent,
  sendTextMessage,
  events,
}) {
  const [terminalState, setTerminalState] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    if (!events || events.length === 0) return;

    const mostRecentEvent = events[0];
    if (
      mostRecentEvent.type === "response.done" &&
      mostRecentEvent.response.output
    ) {
      mostRecentEvent.response.output.forEach(async (output) => {
        console.log("output", output);
        if (output.type === "function_call") {
          // Use call_id to track processed calls; if not available, fallback to a combination of name and timestamp
          const callId = output.call_id || `${output.name}-${Date.now()}`;

          if (busyMap[output.name]) return;
          busyMap[output.name] = true;
          // Indicate processing state locally without sending a new response to the model
          setIsProcessing(true);
          
          // Add debugging to see the structure
          console.log("Function call arguments:", output.arguments);
          
          // Make HTTP call to get terminal state
          try {
            // Parse arguments properly - it might be a string that needs parsing
            let argumentsValue;
            // Check if arguments is a string (JSON) or an object
            if (typeof output.arguments === 'string') {
              argumentsValue = JSON.parse(output.arguments);
            } else {
              argumentsValue = output.arguments;
            }
            
            console.log("Extracted arguments:", argumentsValue);
            
            if (!argumentsValue) {
              console.error("Arguments value is undefined or empty");
              throw new Error("Invalid arguments value");
            }
            const url = `/terminal/${output.name}`;
            
            const response = await axios.post(url, argumentsValue, {
              headers: {
                'Content-Type': 'application/json',
              },
            });

            const data = response.data;
            busyMap[output.name] = false;
            
            // Update state with terminal response - response is an object with terminalState property
            setTerminalState(data.terminalState || JSON.stringify(data, null, 2));
            setIsProcessing(false);
            
            // Build the payload expected by the OpenAI Realtime docs for a function result.
            const functionResultEvent = {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: output.call_id || callId,
                output: JSON.stringify(data),
              },
            };

            // Send the function_result back to the model so it can continue the conversation.
            sendClientEvent(functionResultEvent);

            // Ask the model to produce a response about the terminal state
            sendClientEvent({
              type: "response.create",
            });
          } catch (error) {
            busyMap[output.name] = false;
            console.error("Error processing request:", error);
            setIsProcessing(false);
            sendClientEvent({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: output.call_id || callId,
                output: JSON.stringify({ error: "Failed to process the terminal request" }),
              },
            });
            sendClientEvent({
              type: "response.create",
            });
          }
        }
      });
    }
  }, [events, sendClientEvent]);

  useEffect(() => {
    if (!isSessionActive) {
      setIsProcessing(false);
    }
  }, [isSessionActive]);

  // WebSocket connection for real-time terminal updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'terminal_state') {
          setTerminalState(message.data);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setWsConnected(false);
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setWsConnected(false);
    };
    
    return () => {
      ws.close();
    };
  }, []);

  return (
    <PanelContainer>
      <ContentContainer>
        <ConnectionStatus>
          <StatusIndicator $connected={wsConnected} />
          <span>Terminal WebSocket: {wsConnected ? 'Connected' : 'Disconnected'}</span>
        </ConnectionStatus>
        {isSessionActive ? (
          terminalState ? (
            <TerminalOutput terminalState={terminalState} isProcessing={isProcessing} />
          ) : isProcessing ? (
            <StatusText>Processing terminal command...</StatusText>
          ) : (
            <StatusText>No terminal activity yet</StatusText>
          )
        ) : (
          <StatusText>Start the session to use terminal tools...</StatusText>
        )}
      </ContentContainer>
    </PanelContainer>
  );
}