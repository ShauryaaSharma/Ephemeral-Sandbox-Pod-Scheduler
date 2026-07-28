/** Import necessary libraries */
import axios from 'axios';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from '@emotion/styled';
import { authHeaders } from '../lib/auth';
import { INIT_SERVICE_URL } from '../lib/config';
import { Button, Spinner } from './ui';

/** Constants */
const SLUG_WORKS = ["car", "dog", "computer", "person", "inside", "word", "for", "please", "to", "cool", "open", "source"];

/** Styled components */
const Page = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(ellipse 60% 45% at 15% 10%, rgba(255, 138, 0, 0.08), transparent),
    radial-gradient(ellipse 55% 40% at 90% 90%, rgba(77, 158, 246, 0.07), transparent);
`;

const Card = styled.div`
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 36px 32px;
  box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.5);
`;

const Eyebrow = styled.span`
  display: inline-block;
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: 10px;
`;

const Title = styled.h1`
  font-size: 1.7rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
`;

const Sub = styled.p`
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1.6;
  margin: 0 0 28px;
`;

const Field = styled.div`
  margin-bottom: 16px;
`;

const Label = styled.label`
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 7px;
`;

const InputRow = styled.div`
  display: flex;
  gap: 8px;
`;

const baseFieldStyle = `
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--fg);
  font-size: 0.9rem;
  font-family: var(--mono);
  outline: none;
  transition: border-color 0.15s ease;

  &:focus {
    border-color: var(--accent);
  }
`;

const StyledInput = styled.input`
  ${baseFieldStyle}
`;

const StyledSelect = styled.select`
  ${baseFieldStyle}
  font-family: inherit;
  cursor: pointer;
`;

const RerollButton = styled.button`
  flex-shrink: 0;
  width: 42px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--muted);
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-3);
    color: var(--fg);
  }
`;

const SubmitButton = styled(Button)`
  width: 100%;
  margin-top: 8px;
  padding: 12px 16px;
  font-size: 0.95rem;
`;

const ErrorBox = styled.div`
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  color: var(--red);
  font-size: 0.82rem;
  line-height: 1.5;
`;

/** Helper function */
function getRandomSlug() {
    let slug = "";
    for (let i = 0; i < 3; i++) {
        slug += SLUG_WORKS[Math.floor(Math.random() * SLUG_WORKS.length)];
    }
    return slug;
}

/** Component */
export const Landing = () => {
    const [language, setLanguage] = useState("node-js");
    const [replId, setReplId] = useState(getRandomSlug());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const navigate = useNavigate();

    const startProject = async () => {
        if (!replId.trim()) {
            setError("Give your project a name first.");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const headers = await authHeaders();
            await axios.post(`${INIT_SERVICE_URL}/project`, { replId, language }, { headers });
            navigate(`/coding/?replId=${replId}`);
        } catch (err) {
            const serverMessage = axios.isAxiosError(err) && err.response?.data?.message;
            setError(serverMessage || "Couldn't create the project. Please try again.");
            setLoading(false);
        }
    };

    return (
      <Page>
        <Card>
          <Eyebrow>ephemeral sandbox</Eyebrow>
          <Title>Start a new project</Title>
          <Sub>Pick a name and a language - we'll schedule a dedicated pod for it in a few seconds.</Sub>

          <Field>
            <Label htmlFor="repl-id">Project name</Label>
            <InputRow>
              <StyledInput
                id="repl-id"
                onChange={(e) => setReplId(e.target.value)}
                type="text"
                placeholder="my-project"
                value={replId}
                disabled={loading}
              />
              <RerollButton
                type="button"
                title="Generate a random name"
                onClick={() => setReplId(getRandomSlug())}
                disabled={loading}
              >
                ⟳
              </RerollButton>
            </InputRow>
          </Field>

          <Field>
            <Label htmlFor="language">Language</Label>
            <StyledSelect
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={loading}
            >
              <option value="node-js">Node.js</option>
              <option value="python">Python</option>
            </StyledSelect>
          </Field>

          <SubmitButton disabled={loading} onClick={startProject}>
            {loading ? <><Spinner size={15} /> Starting…</> : "Start coding"}
          </SubmitButton>

          {error && <ErrorBox>{error}</ErrorBox>}
        </Card>
      </Page>
    );
}
