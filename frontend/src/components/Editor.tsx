import { useEffect, useMemo, useState } from "react";
import Sidebar from "./external/editor/components/sidebar";
import { Code } from "./external/editor/editor/code";
import styled from "@emotion/styled";
import { File, buildFileTree, RemoteFile } from "./external/editor/utils/file-manager";
import { FileTree } from "./external/editor/components/file-tree";
import { Socket } from "socket.io-client";

// credits - https://codesandbox.io/s/monaco-tree-pec7u
export const Editor = ({
    files,
    onSelect,
    selectedFile,
    socket
}: {
    files: RemoteFile[];
    onSelect: (file: File) => void;
    selectedFile: File | undefined;
    socket: Socket;
}) => {
  const rootDir = useMemo(() => {
    return buildFileTree(files);
  }, [files]);

  useEffect(() => {
    if (!selectedFile) {
      onSelect(rootDir.files[0])
    }
  }, [selectedFile])

  return (
    <Main>
      <Sidebar>
        <FileTree
          rootDir={rootDir}
          selectedFile={selectedFile}
          onSelect={onSelect}
        />
      </Sidebar>
      <CodeArea>
        <Code socket={socket} selectedFile={selectedFile} />
      </CodeArea>
    </Main>
  );
};

const Main = styled.main`
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
`;

const CodeArea = styled.div`
  flex: 1;
  min-width: 0;
`;