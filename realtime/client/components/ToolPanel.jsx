import React, { useEffect, useState } from "react";
import styled from 'styled-components';

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
  background-color: #f3f4f6;
  border-radius: 0.375rem;
  padding: 0.5rem;
  width: 100%;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
`;

const StatusText = styled.p`
  margin: 0;
`;

function FunctionCallOutput({ plan, changes }) {
  return (
    <OutputContainer>
      <OutputSection>
        {plan && (
          <>
            <SectionTitle>Plan</SectionTitle>
            <CodeBlock>{plan}</CodeBlock>
          </>
        )}
        {changes && (
          <>
            <SectionTitle>Changes</SectionTitle>
            <CodeBlock>{changes}</CodeBlock>
          </>
        )}
      </OutputSection>
    </OutputContainer>
  );
}

let busyMap = {};
// let processedCalls = {};

export default function ToolPanel({
  isSessionActive,
  sendClientEvent,
  sendTextMessage,
  events,
}) {
  const [plan, setPlan] = useState(null);
  const [changes, setChanges] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!events || events.length === 0) return;

    const mostRecentEvent = events[0];
    if (
      mostRecentEvent.type === "response.done" &&
      mostRecentEvent.response.output
    ) {
      mostRecentEvent.response.output.forEach((output) => {
        console.log("output", output);
        if (output.type === "function_call" && (output.name === "plan_changes" || output.name === "apply_changes")) {
          // Use call_id to track processed calls; if not available, fallback to a combination of name and timestamp
          const callId = output.call_id || `${output.name}-${Date.now()}`;
          // if (processedCalls[callId]) return;
          // processedCalls[callId] = true;

          if (busyMap[output.name]) return;
          busyMap[output.name] = true;
          // Indicate processing state locally without sending a new response to the model
          // Sending a new `response.create` here interrupts the model's current audio stream,
          // so instead we just update the local UI state.
          setIsProcessing(true);
          
          // Add debugging to see the structure
          console.log("Function call arguments:", output.arguments);
          
          // Make HTTP call to the server
          // Parse arguments properly - it might be a string that needs parsing
          let promptValue;
          try {
            // Check if arguments is a string (JSON) or an object
            if (typeof output.arguments === 'string') {
              const parsedArgs = JSON.parse(output.arguments);
              promptValue = parsedArgs.prompt;
            } else {
              promptValue = output.arguments.prompt;
            }
            
            // console.log("Extracted prompt value:", promptValue);
            
            if (!promptValue) {
              console.error("Prompt value is undefined or empty");
              throw new Error("Invalid prompt value");
            }

            if(output.name === "apply_changes" && (plan || changes)) {
              const prompt_prefix = JSON.stringify("The plan so far is as follows:\n"+plan+"\n\n"+changes);
              promptValue = prompt_prefix + "\n\n" + promptValue;
            }

            const url = output.name === "plan_changes" ? "/claudecode/plan" : "/claudecode/apply";
            fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ prompt: promptValue }),
            })
              .then(response => response.json())
              .then(data => {
                busyMap[output.name] = false;
                // Update state with response
                if(output.name === "plan_changes") {
                  setPlan(data.plan);
                } else if(output.name === "apply_changes") {
                  setChanges(data.changes);
                }
                setIsProcessing(false);
                
                // Build the payload expected by the OpenAI Realtime docs for a function result.
                const functionResultEvent = {
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: output.call_id || callId,
                    // 'name' is not required for function_call_output per Realtime API spec
                    output: JSON.stringify(data),
                  },
                };

                // 1) Send the function_result back to the model so it can continue the conversation.
                sendClientEvent(functionResultEvent);

                // 2) Ask the model to produce a concise natural-language summary.
                const summaryInstructions =
                  output.name === "plan_changes"
                    ? "Summarize the provided plan in one short sentence, listing the files that will be changed (paths relative to the project root)."
                    : "Summarize the code diff succinctly – what changed and in which files (paths relative to the project root).";

                sendClientEvent({
                  type: "response.create",
                  response: {
                    instructions: summaryInstructions,
                  },
                });
              })
              .catch(error => {
                busyMap[output.name] = false;
                console.error("Error planning changes:", error);
                setIsProcessing(false);
                sendClientEvent({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: output.call_id || callId,
                    // 'name' is not required for function_call_output per Realtime API spec
                    output: JSON.stringify({ error: "Failed to process the request" }),
                  },
                });
                sendClientEvent({
                  type: "response.create",
                  response: {
                    instructions: `
                    Sorry, there was an error planning the changes. Please try again.
                    `,
                  },
                });
              });
          } catch (error) {
            busyMap[output.name] = false;
            console.error("Error parsing function call arguments:", error);
            setIsProcessing(false);
            sendClientEvent({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: output.call_id || callId,
                // 'name' is not required for function_call_output per Realtime API spec
                output: JSON.stringify({ error: "Invalid arguments provided" }),
              },
            });
            sendClientEvent({
              type: "response.create",
              response: {
                instructions: `
                Sorry, there was an error processing the function call. Please try again.
                `,
              },
            });
          }
        }
        
        if (output.type === "function_call" && output.name === "apply_changes") {
        }
      });
    }
  }, [events, sendClientEvent]);

  useEffect(() => {
    if (!isSessionActive) {
      setIsProcessing(false);
      // Reset processed calls when session ends
      // processedCalls = {};
    }
  }, [isSessionActive]);

  return (
    <PanelContainer>
      <ContentContainer>
        {isSessionActive ? (
          isProcessing ? (
            <StatusText>Waiting for claude code...</StatusText>
          ) : (plan || changes) ? (
            <FunctionCallOutput plan={plan} changes={changes} />
          ) : (
            <StatusText>no plan or changes</StatusText>
          )
        ) : (
          <StatusText>Start the session to use this tool...</StatusText>
        )}
      </ContentContainer>
    </PanelContainer>
  );
}