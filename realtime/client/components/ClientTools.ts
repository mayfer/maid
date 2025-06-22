export const clientTools = [
    {
      type: "function",
      name: "type",
      description:
        `Type text into the terminal. To submit text, an additional call to press_key is required with the key "Enter".`,
      parameters: {
        type: "object",
        strict: true,
        properties: {
          text: {
            type: "string",
            description: "Text to type into the terminal.",
          },
  {
    type: "function",
    name: "submitText",
    description: `Type text into the terminal and then press the Enter key to immediately submit it. Useful for sending full commands in one step without an additional press_key call.`,
    parameters: {
      type: "object",
      strict: true,
      properties: {
        text: {
          type: "string",
          description: "Text to type into the terminal and submit (followed by an automatic Enter keypress).",
        },
      },
      required: ["text"],
    },
  },
        },
        required: ["text"],
      },
    },
    {
      type: "function",
      name: "press_key",
      description:
        `Press a specific key in the terminal. Use this for special keys like arrow keys, enter, etc. The key uses tmux key format for tmux send-keys, so for example Ctrl+C is "C-c" and Command+C is "M-c".`,
      parameters: {
        type: "object",
        strict: true,
        properties: {
          key: {
            type: "string",
            description: "Key to press in tmux key format.",
          },
        },
        required: ["key"],
      },
    },
    {
      type: "function",
      name: "get_terminal_state",
      description:
        `Get the current state of the terminal including the visible content and cursor position.`,
      parameters: {
        type: "object",
        strict: true,
        properties: {},
        required: [],
      },
    },
  ]