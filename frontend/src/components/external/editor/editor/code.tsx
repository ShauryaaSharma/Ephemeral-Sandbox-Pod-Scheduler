import Editor from "@monaco-editor/react";
import { useState } from "react";
import styled from "@emotion/styled";
import { File } from "../utils/file-manager";
import { Socket } from "socket.io-client";
import { getIcon } from "../components/icon";

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
`;

const TabBar = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
  flex-shrink: 0;
`;

const SaveState = styled.span`
  margin-left: auto;
  font-size: 0.72rem;
  color: var(--faint);
`;

const Empty = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  font-size: 0.9rem;
`;

export const Code = ({ selectedFile, socket }: { selectedFile: File | undefined, socket: Socket }) => {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  if (!selectedFile)
    return <Wrapper><Empty>Select a file to start editing</Empty></Wrapper>

  const code = selectedFile.content
  let language = selectedFile.name.split('.').pop()

  if (language === "js" || language === "jsx")
    language = "javascript";
  else if (language === "ts" || language === "tsx")
    language = "typescript"
  else if (language === "py" )
    language = "python"

    function debounce(func: (value: string) => void, wait: number) {
      let timeout: number;
      return (value: string) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          func(value);
        }, wait);
      };
    }

  return (
    <Wrapper>
      <TabBar>
        {getIcon(selectedFile.name.split('.').pop() || "", selectedFile.name)}
        {selectedFile.name}
        {saveState !== "idle" && <SaveState>{saveState === "saving" ? "Saving…" : "Saved"}</SaveState>}
      </TabBar>
      <Editor
        height="100%"
        language={language}
        value={code}
        theme="vs-dark"
        onChange={debounce((value) => {
          setSaveState("saving");
          // Should send diffs, for now sending the whole file
          // PR and win a bounty!
          socket.emit("updateContent", { path: selectedFile.path, content: value });
          setSaveState("saved");
        }, 500)}
        options={{ minimap: { enabled: true }, fontSize: 13.5 }}
      />
    </Wrapper>
  )
}
