export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 24,
        textAlign: "center",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>No public profile here</h1>
      {/* One page for "unknown handle" and "private profile", matching the
          API's deliberate 404 ambiguity. */}
      <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>
        This handle doesn&apos;t exist, or its owner keeps their profile private.
      </p>
      <a
        href="https://trysynara.com"
        style={{ color: "var(--muted)", fontSize: 13, marginTop: 12 }}
      >
        trysynara.com
      </a>
    </main>
  );
}
