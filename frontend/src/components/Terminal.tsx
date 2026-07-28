import { useEffect, useRef } from "react"
import styled from "@emotion/styled";
import { Socket } from "socket.io-client";
import { Terminal } from "xterm";
import { FitAddon } from 'xterm-addon-fit';
const fitAddon = new FitAddon();

function ab2str(buf: string) {
    return String.fromCharCode.apply(null, new Uint8Array(buf));
}

const OPTIONS_TERM = {
    useStyle: true,
    screenKeys: true,
    cursorBlink: true,
    theme: {
        background: "#0e1525",
        foreground: "#f5f9fc",
        cursor: "#ff8a00",
        selectionBackground: "rgba(255, 138, 0, 0.3)",
    },
    fontSize: 13,
    fontFamily: "ui-monospace, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
};

const Panel = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: #0e1525;
`;

const Header = styled.div`
  padding: 8px 14px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`;

const TermArea = styled.div`
  flex: 1;
  min-height: 0;
  padding: 8px 4px 4px 10px;
`;

export const TerminalComponent = ({ socket }: {socket: Socket}) => {
    const terminalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!terminalRef || !terminalRef.current || !socket) {
            return;
        }

        socket.emit("requestTerminal");
        socket.on("terminal", terminalHandler)
        const term = new Terminal(OPTIONS_TERM)
        term.loadAddon(fitAddon);
        term.open(terminalRef.current);
        fitAddon.fit();
        function terminalHandler({ data }) {
            if (data instanceof ArrayBuffer) {
                term.write(ab2str(data))
            }
        }
        term.onData((data) => {
            socket.emit('terminalData', {
                data
            });
        });

        socket.emit('terminalData', {
            data: '\n'
        });

        const resizeObserver = new ResizeObserver(() => {
            try {
                fitAddon.fit();
            } catch {
                // panel not visible / zero-size mid-transition, safe to ignore
            }
        });
        resizeObserver.observe(terminalRef.current);

        return () => {
            socket.off("terminal")
            resizeObserver.disconnect();
            term.dispose();
        }
    }, [terminalRef, socket]);

    return (
        <Panel>
            <Header>Terminal</Header>
            <TermArea ref={terminalRef} />
        </Panel>
    );
}
