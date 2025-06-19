import React from "react";
import styled from 'styled-components';

const StyledButton = styled.button`
  background-color: #1f2937;
  color: white;
  border-radius: 9999px;
  padding: 1rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  border: none;
  cursor: pointer;
  transition: opacity 0.2s;
  
  &:hover {
    opacity: 0.9;
  }
  
  ${props => props.className && `
    /* Additional styles can be passed via className prop */
  `}
`;

export default function Button({ icon, children, onClick, className }) {
  return (
    <StyledButton
      onClick={onClick}
      className={className}
    >
      {icon}
      {children}
    </StyledButton>
  );
}
