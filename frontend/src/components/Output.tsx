import { useSearchParams } from "react-router-dom";

const APP_DOMAIN = import.meta.env.VITE_APP_DOMAIN ?? 'autogpt-cloud.com';

export const Output = () => {
    const [searchParams] = useSearchParams();
    const replId = searchParams.get('replId') ?? '';
    const INSTANCE_URI = `http://${replId}.${APP_DOMAIN}`;

    return <div style={{height: "40vh", background: "white"}}>
        <iframe width={"100%"} height={"100%"} src={`${INSTANCE_URI}`} />
    </div>
}