import React, {ReactNode} from 'react';
import styled from "@emotion/styled";

export const Sidebar = ({children}: { children: ReactNode }) => {
  return (
    <Aside>
      <Header>Explorer</Header>
      <Files>
        {children}
      </Files>
    </Aside>
  )
}

const Aside = styled.aside`
  width: 230px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--surface);
`

const Header = styled.div`
  padding: 10px 14px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const Files = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
`

export default Sidebar
