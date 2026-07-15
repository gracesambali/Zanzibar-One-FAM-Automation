// Facilities overview - lists all facilities pulled from Airtable with
// current status. Links through to /facility/[id] for the live view.

import base, { TABLES } from "../lib/airtable";

export async function getServerSideProps() {
  const records = await base(TABLES.FACILITIES)
    .select({ view: "Grid view" })
    .firstPage();

  const facilities = records.map((r) => ({
    id: r.id,
    name: r.fields["Facility Name"] || "Untitled",
    status: r.fields["Status"] || "Scoped",
    city: r.fields["City"] || "",
  }));

  return { props: { facilities } };
}

export default function Home({ facilities }) {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>GVC Facility Asset Manager</h1>
      <p>Live facility status, sensor readings, and digital twin links.</p>
      <ul>
        {facilities.map((f) => (
          <li key={f.id} style={{ marginBottom: "0.5rem" }}>
            <a href={`/facility/${f.id}`}>{f.name}</a> — {f.city} —{" "}
            <em>{f.status}</em>
          </li>
        ))}
      </ul>
    </main>
  );
}
