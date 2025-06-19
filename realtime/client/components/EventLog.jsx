import { ArrowUp, ArrowDown } from "react-feather";
import React, { useState } from "react";
import styled from 'styled-components';

const EventContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  border-radius: 0.375rem;
  background-color: #f9fafb;
`;

const EventHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
`;

const EventTimestamp = styled.div`
  font-size: 0.875rem;
  color: #6b7280;
`;

const EventContent = styled.div`
  color: #6b7280;
  background-color: #e5e7eb;
  padding: 0.5rem;
  border-radius: 0.375rem;
  overflow-x: auto;
  display: ${props => props.$isExpanded ? 'block' : 'none'};
`;

const EventPre = styled.pre`
  font-size: 0.75rem;
`;

const LogContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
`;

const AwaitingText = styled.div`
  color: #6b7280;
`;

const ClientIcon = styled(ArrowDown)`
  color: #60a5fa;
`;

const ServerIcon = styled(ArrowUp)`
  color: #34d399;
`;

function Event({ event, timestamp }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isClient = event.event_id && !event.event_id.startsWith("event_");

  return (
    <EventContainer>
      <EventHeader onClick={() => setIsExpanded(!isExpanded)}>
        {isClient ? (
          <ClientIcon />
        ) : (
          <ServerIcon />
        )}
        <EventTimestamp>
          {isClient ? "client:" : "server:"}
          &nbsp;{event.type} | {timestamp}
        </EventTimestamp>
      </EventHeader>
      <EventContent $isExpanded={isExpanded}>
        <EventPre>{JSON.stringify(event, null, 2)}</EventPre>
      </EventContent>
    </EventContainer>
  );
}

export default function EventLog({ events }) {
  const eventsToDisplay = [];
  let deltaEvents = {};

  events.forEach((event) => {
    if (event.type.endsWith("delta")) {
      if (deltaEvents[event.type]) {
        // for now just log a single event per render pass
        return;
      } else {
        deltaEvents[event.type] = event;
      }
    }

    eventsToDisplay.push(
      <Event key={event.event_id} event={event} timestamp={event.timestamp} />,
    );
  });

  return (
    <LogContainer>
      {events.length === 0 ? (
        <AwaitingText>Awaiting events...</AwaitingText>
      ) : (
        eventsToDisplay
      )}
    </LogContainer>
  );
}
