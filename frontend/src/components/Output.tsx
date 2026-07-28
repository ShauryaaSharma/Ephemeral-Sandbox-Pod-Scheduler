import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import styled from "@emotion/styled";
import { outputUrl } from "../lib/config";
import { IconButton, Spinner } from "./ui";

const Panel = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: white;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`;

const Url = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 0.74rem;
  color: var(--muted);
`;

const Body = styled.div`
  flex: 1;
  min-height: 0;
  position: relative;
`;

const LoadingOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.8rem;
`;

const Frame = styled.iframe`
  width: 100%;
  height: 100%;
  border: none;
`;

export const Output = () => {
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';
    const INSTANCE_URI = outputUrl(replId);
    const [loading, setLoading] = useState(true);
    const [reloadKey, setReloadKey] = useState(0);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const refresh = () => {
        setLoading(true);
        setReloadKey((k) => k + 1);
    };

    return (
        <Panel>
            <Header>
                <Url>{INSTANCE_URI}</Url>
                <IconButton title="Refresh" onClick={refresh}>↻</IconButton>
            </Header>
            <Body>
                {loading && (
                    <LoadingOverlay>
                        <Spinner size={16} /> Waiting for your app to respond…
                    </LoadingOverlay>
                )}
                <Frame
                    key={reloadKey}
                    ref={iframeRef}
                    src={INSTANCE_URI}
                    onLoad={() => setLoading(false)}
                />
            </Body>
        </Panel>
    );
}
