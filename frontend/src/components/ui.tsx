import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

export const Spinner = styled.span<{ size?: number }>`
  display: inline-block;
  width: ${(p) => p.size ?? 18}px;
  height: ${(p) => p.size ?? 18}px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: ${spin} 0.7s linear infinite;
  flex-shrink: 0;
`;

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

export const Dot = styled.span<{ color: string; pulse?: boolean }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${(p) => p.color};
  box-shadow: 0 0 8px -1px ${(p) => p.color};
  ${(p) => p.pulse && `animation: ${pulse} 1.6s ease-in-out infinite;`}
`;

export const Button = styled.button<{ variant?: 'primary' | 'ghost' | 'danger' }>`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  white-space: nowrap;

  ${(p) =>
    (!p.variant || p.variant === 'primary') &&
    `
      background: var(--accent);
      color: #1a1000;
      &:hover { background: var(--accent-2); }
    `}

  ${(p) =>
    p.variant === 'ghost' &&
    `
      background: transparent;
      color: var(--fg);
      border-color: var(--border-strong);
      &:hover { background: var(--surface-2); }
    `}

  ${(p) =>
    p.variant === 'danger' &&
    `
      background: transparent;
      color: var(--red);
      border-color: rgba(248, 113, 113, 0.35);
      &:hover { background: rgba(248, 113, 113, 0.1); }
    `}

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

export const Card = styled.div`
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
`;

export const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-2);
    color: var(--fg);
  }
`;
