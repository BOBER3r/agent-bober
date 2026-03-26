import { useState, useEffect } from "react";

interface HealthStatus {
  status: string;
  timestamp: string;
}

export default function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: HealthStatus) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem" }}>
      <h1>Welcome to Your App</h1>
      <p>
        Edit <code>src/App.tsx</code> to get started.
      </p>
      <section>
        <h2>API Status</h2>
        {health ? (
          <p>
            Server is <strong>{health.status}</strong> (checked at{" "}
            {new Date(health.timestamp).toLocaleTimeString()})
          </p>
        ) : (
          <p>Connecting to server...</p>
        )}
      </section>
    </main>
  );
}
