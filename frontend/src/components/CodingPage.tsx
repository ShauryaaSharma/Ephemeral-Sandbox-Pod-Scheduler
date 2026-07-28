import { useEffect, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import { Editor } from './Editor';
import { File, RemoteFile, Type } from './external/editor/utils/file-manager';
import { useNavigate, useSearchParams } from 'react-router-dom';
import styled from '@emotion/styled';
import { Output } from './Output';
import { TerminalComponent as Terminal } from './Terminal';
import axios from 'axios';
import { authHeaders, getAuthToken } from '../lib/auth';
import { ORCHESTRATOR_URL, socketUrl } from '../lib/config';
import { Button, Dot, Spinner } from './ui';

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

/** ---- Layout ---- */

const Page = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  overflow: hidden;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`;

const ToolbarLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
`;

const ProjectName = styled.span`
  font-family: var(--mono);
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const HealthPill = styled.div<{ tone: 'green' | 'red' | 'gray' }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 8px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  background: ${(p) =>
    p.tone === 'green' ? 'rgba(52, 211, 153, 0.12)' : p.tone === 'red' ? 'rgba(248, 113, 113, 0.12)' : 'var(--surface-2)'};
  color: ${(p) => (p.tone === 'green' ? 'var(--green)' : p.tone === 'red' ? 'var(--red)' : 'var(--muted)')};
`;

const ToolbarRight = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const UnhealthyBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(248, 113, 113, 0.12);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
  color: var(--red);
  padding: 8px 16px;
  font-size: 0.82rem;
  flex-shrink: 0;
`;

const Workspace = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 10px;
  padding: 10px;
`;

const LeftPanel = styled.div`
  flex: 3;
  min-width: 0;
  display: flex;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface);
`;

const RightPanel = styled.div`
  flex: 2;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

/** ---- Loading / error stage screen (shared by both "booting" states) ---- */

const StagePage = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
`;

const StageCard = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  text-align: center;
  max-width: 380px;
  padding: 0 24px;
`;

const StageTitle = styled.h2`
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0;
`;

const StageSub = styled.p`
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0;
  line-height: 1.6;
`;

const StageErrorIcon = styled.div`
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(248, 113, 113, 0.12);
  color: var(--red);
  font-size: 1.3rem;
`;

function StageScreen({
    title,
    sub,
    error,
    onRetry,
}: {
    title: string;
    sub?: string;
    error?: string | null;
    onRetry?: () => void;
}) {
    return (
        <StagePage>
            <StageCard>
                {error ? <StageErrorIcon>!</StageErrorIcon> : <Spinner size={30} />}
                <StageTitle>{error ? 'Something went wrong' : title}</StageTitle>
                <StageSub>{error ?? sub}</StageSub>
                {error && onRetry && (
                    <Button onClick={onRetry}>Try again</Button>
                )}
            </StageCard>
        </StagePage>
    );
}

/** ---- Top-level: schedules the pod before mounting the real IDE ---- */

export const CodingPage = () => {
    const [podCreated, setPodCreated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [slow, setSlow] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';

    useEffect(() => {
        if (!replId) return;
        let cancelled = false;
        setError(null);
        setSlow(false);

        const slowTimer = setTimeout(() => {
            if (!cancelled) setSlow(true);
        }, 4000);

        authHeaders()
            .then((headers) => axios.post(`${ORCHESTRATOR_URL}/start`, { replId }, { headers }))
            .then(() => {
                if (!cancelled) setPodCreated(true);
            })
            .catch((err) => {
                console.error(err);
                if (cancelled) return;
                const serverMessage = axios.isAxiosError(err) && err.response?.data?.message;
                setError(serverMessage || 'Failed to start your sandbox. Please try again.');
            })
            .finally(() => clearTimeout(slowTimer));

        return () => {
            cancelled = true;
            clearTimeout(slowTimer);
        };
    }, [replId, attempt]);

    if (error) {
        return <StageScreen title="" error={error} onRetry={() => setAttempt((a) => a + 1)} />;
    }

    if (!podCreated) {
        return (
            <StageScreen
                title="Waking up your sandbox…"
                sub={slow ? 'Still working - checking the cluster has room for your pod.' : 'Scheduling a dedicated pod for this project.'}
            />
        );
    }
    return <CodingPagePostPodCreation />
}

export const CodingPagePostPodCreation = () => {
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';
    const [loaded, setLoaded] = useState(false);
    const [stopping, setStopping] = useState(false);
    const socket = useSocket(replId);
    const [fileStructure, setFileStructure] = useState<RemoteFile[]>([]);
    const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
    const [showOutput, setShowOutput] = useState(false);
    const health = useProjectHealth(replId);
    const navigate = useNavigate();

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

    const stopProject = async () => {
        setStopping(true);
        try {
            const headers = await authHeaders();
            await axios.post(`${ORCHESTRATOR_URL}/stop`, { replId }, { headers });
        } catch (err) {
            console.error('failed to stop project', err);
        }
        navigate('/');
    };

    if (!socket) {
        return <StageScreen title="Connecting…" sub="Opening a connection to your pod." />;
    }

    if (!loaded) {
        return <StageScreen title="Loading your files…" sub="Almost there." />;
    }

    const healthTone = health?.healthStatus === 'healthy' ? 'green' : health?.healthStatus === 'unhealthy' ? 'red' : 'gray';

    return (
        <Page>
            <Toolbar>
                <ToolbarLeft>
                    <ProjectName>{replId}</ProjectName>
                    <HealthPill tone={healthTone}>
                        <Dot color={`var(--${healthTone === 'gray' ? 'faint' : healthTone})`} pulse={healthTone === 'green'} />
                        {health?.healthStatus ?? 'unknown'}
                    </HealthPill>
                </ToolbarLeft>
                <ToolbarRight>
                    <Button variant={showOutput ? 'primary' : 'ghost'} onClick={() => setShowOutput(!showOutput)}>
                        {showOutput ? 'Hide output' : 'See output'}
                    </Button>
                    <Button variant="danger" onClick={stopProject} disabled={stopping}>
                        {stopping ? <><Spinner size={13} /> Stopping…</> : 'Stop'}
                    </Button>
                </ToolbarRight>
            </Toolbar>

            {health?.healthStatus === 'unhealthy' && (
                <UnhealthyBanner>
                    <Dot color="var(--red)" />
                    This project's pod is unhealthy ({health.unhealthyReason ?? 'crash-looping'}, {health.restartCount} restarts) - you may need to fix your code and restart it.
                </UnhealthyBanner>
            )}

            <Workspace>
                <LeftPanel>
                    <Editor socket={socket} selectedFile={selectedFile} onSelect={onSelect} files={fileStructure} />
                </LeftPanel>
                <RightPanel>
                    {showOutput && <Output />}
                    <Terminal socket={socket} />
                </RightPanel>
            </Workspace>
        </Page>
    );
}
