import React, { useEffect, useState } from "react";
import styled from 'styled-components';
import axios from 'axios';

const PanelContainer = styled.section`
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const ContentContainer = styled.div`
  height: 100%;
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
  
  ${props => props.isLoading && `
    &::before {
      content: '';
      position: absolute;
      top: -2px;
      left: -2px;
      right: -2px;
      bottom: -2px;
      background: linear-gradient(45deg, #3b82f6, #8b5cf6, #06b6d4, #3b82f6);
      background-size: 400% 400%;
      border-radius: 0.5rem;
      z-index: -1;
      animation: glow 2s ease-in-out infinite alternate;
    }
    
    @keyframes glow {
      0% {
        background-position: 0% 50%;
        opacity: 0.8;
      }
      100% {
        background-position: 100% 50%;
        opacity: 1;
      }
    }
  `}
`;

const LoadingText = styled.div`
  color: #3b82f6;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  padding: 0.5rem;
  animation: pulse 1.5s ease-in-out infinite;
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const StatusText = styled.p`
  margin: 0;
`;

function TerminalOutput({ terminalState, isProcessing }) {
  return (
    <OutputContainer>
      <OutputSection>
        {terminalState && (
          <>
            <SectionTitle>Terminal State</SectionTitle>
            <CodeBlock isLoading={isProcessing}>{terminalState}</CodeBlock>
            {isProcessing && <LoadingText>Loading...</LoadingText>}
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
              response: {
                instructions: "Describe what happened in the terminal based on the function call result. Be concise and helpful.",
              },
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
              response: {
                instructions: "Sorry, there was an error with the terminal operation. Please try again.",
              },
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

  return (
    <PanelContainer>
      <ContentContainer>
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