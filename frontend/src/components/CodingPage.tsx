import { useEffect, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import { Editor } from './Editor';
import { File, RemoteFile, Type } from './external/editor/utils/file-manager';
import { useSearchParams } from 'react-router-dom';
import styled from '@emotion/styled';
import { Output } from './Output';
import { TerminalComponent as Terminal } from './Terminal';
import axios from 'axios';
import { authHeaders, getAuthToken } from '../lib/auth';
import { ORCHESTRATOR_URL, socketUrl } from '../lib/config';

interface ProjectHealth {
    healthStatus: 'unknown' | 'healthy' | 'unhealthy';
    restartCount: number;
    unhealthyReason: string | null;
}

const HEALTH_POLL_INTERVAL_MS = 20000;

// Polls orchestrator-simple's per-project status endpoint so the user sees
// "this project's pod is unhealthy" instead of a silently broken terminal
// (see Priority 4's crash-loop detection).
function useProjectHealth(replId: string): ProjectHealth | null {
    const [health, setHealth] = useState<ProjectHealth | null>(null);

    useEffect(() => {
        if (!replId) return;
        let cancelled = false;

        const poll = async () => {
            try {
                const headers = await authHeaders();
                const { data } = await axios.get(`${ORCHESTRATOR_URL}/projects/${replId}/status`, { headers });
                if (!cancelled) setHealth(data);
            } catch (err) {
                console.error('failed to poll project health', err);
            }
        };

        poll();
        const interval = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [replId]);

    return health;
}

const UnhealthyBanner = styled.div`
  background: #b00020;
  color: white;
  padding: 10px 16px;
  font-size: 14px;
`;

function useSocket(replId: string) {
    const [socket, setSocket] = useState<Socket | null>(null);

    useEffect(() => {
        let cancelled = false;
        let createdSocket: Socket | null = null;

        getAuthToken().then((token) => {
            if (cancelled) return;
            createdSocket = io(socketUrl(replId), { auth: { token } });
            setSocket(createdSocket);
        });

        return () => {
            cancelled = true;
            createdSocket?.disconnect();
        };
    }, [replId]);

    return socket;
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
`;

const ButtonContainer = styled.div`
  display: flex;
  justify-content: flex-end; /* Aligns children (button) to the right */
  padding: 10px; /* Adds some space around the button */
`;

const Workspace = styled.div`
  display: flex;
  margin: 0;
  font-size: 16px;
  width: 100%;
`;

const LeftPanel = styled.div`
  flex: 1;
  width: 60%;
`;

const RightPanel = styled.div`
  flex: 1;
  width: 40%;
`;


export const CodingPage = () => {
    const [podCreated, setPodCreated] = useState(false);
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';
    
    useEffect(() => {
        if (replId) {
            authHeaders()
                .then((headers) => axios.post(`${ORCHESTRATOR_URL}/start`, { replId }, { headers }))
                .then(() => setPodCreated(true))
                .catch((err) => console.error(err));
        }
    }, []);

    if (!podCreated) {
        return <>Booting...</>
    }
    return <CodingPagePostPodCreation />

}

export const CodingPagePostPodCreation = () => {
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';
    const [loaded, setLoaded] = useState(false);
    const socket = useSocket(replId);
    const [fileStructure, setFileStructure] = useState<RemoteFile[]>([]);
    const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
    const [showOutput, setShowOutput] = useState(false);
    const health = useProjectHealth(replId);

    useEffect(() => {
        if (socket) {
            socket.on('loaded', ({ rootContent }: { rootContent: RemoteFile[]}) => {
                setLoaded(true);
                setFileStructure(rootContent);
            });
        }
    }, [socket]);

    const onSelect = (file: File) => {
        if (file.type === Type.DIRECTORY) {
            socket?.emit("fetchDir", file.path, (data: RemoteFile[]) => {
                setFileStructure(prev => {
                    const allFiles = [...prev, ...data];
                    return allFiles.filter((file, index, self) => 
                        index === self.findIndex(f => f.path === file.path)
                    );
                });
            });
        } else {
            socket?.emit("fetchContent", { path: file.path }, (data: string) => {
                file.content = data;
                setSelectedFile(file);
            });
        }
    };
    
    if (!loaded) {
        return "Loading...";
    }

    return (
        <Container>
            {health?.healthStatus === 'unhealthy' && (
                <UnhealthyBanner>
                    This project's pod is unhealthy ({health.unhealthyReason ?? 'crash-looping'}, {health.restartCount} restarts) - you may need to fix your code and restart it.
                </UnhealthyBanner>
            )}
             <ButtonContainer>
                <button onClick={() => setShowOutput(!showOutput)}>See output</button>
            </ButtonContainer>
            <Workspace>
                <LeftPanel>
                    <Editor socket={socket} selectedFile={selectedFile} onSelect={onSelect} files={fileStructure} />
                </LeftPanel>
                <RightPanel>
                    {showOutput && <Output />}
                    <Terminal socket={socket} />
                </RightPanel>
            </Workspace>
        </Container>
    );
}
