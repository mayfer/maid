import styled, { createGlobalStyle } from 'styled-components';

const GlobalStyle = createGlobalStyle`
  :root {
    --color-base: #efefef;
    --color-highlight: #ff80ff;
  }

  html, body {
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    font-family: "Consolas", "Andale Mono", monospace;
    font-size: 0.9rem;
    background-color: var(--color-base);
  }

  * {
    box-sizing: border-box;
  }

  #root {
    height: 100%;
    width: 100%;
  }
`;

export default GlobalStyle; 