// Per-facility live view: digital twin link, 360 tour, as-built drawings,
// and current sensor status per asset. Matterport tags deep-link here via
// #asset-<assetId> anchors.

import base, { TABLES } from "../../lib/airtable";

export async function getServerSideProps({ params }) {
  const facility = await base(TABLES.FACILITIES).find(params.id);

  const assetIds = facility.fields["Assets"] || [];
  const assets = await Promise.all(
    assetIds.map((id) => base(TABLES.ASSETS).find(id))
  );

  return {
    props: {
      facility: {
        id: facility.id,
        name: facility.fields["Facility Name"] || "Untitled",
        digitalTwinUrl: facility.fields["Digital Twin URL"] || null,
        tourUrl: facility.fields["360 Tour URL"] || null,
      },
      assets: assets.map((a) => ({
        id: a.id,
        name: a.fields["Asset Name"] || "Untitled asset",
        type: a.fields["Asset Type"] || "",
        targetTemp: a.fields["Target Range (Temp)"] || "",
        targetHumidity: a.fields["Target Range (Humidity)"] || "",
      })),
    },
  };
}

export default function FacilityPage({ facility, assets }) {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <a href="/">&larr; All facilities</a>
      <h1>{facility.name}</h1>

      <div style={{ display: "flex", gap: "1rem", margin: "1rem 0" }}>
        {facility.digitalTwinUrl && (
          <a href={facility.digitalTwinUrl} target="_blank" rel="noreferrer">
            View Digital Twin
          </a>
        )}
        {facility.tourUrl && (
          <a href={facility.tourUrl} target="_blank" rel="noreferrer">
            View 360 Tour
          </a>
        )}
      </div>

      <h2>Assets & Live Status</h2>
      <table cellPadding="8" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th>Asset</th>
            <th>Type</th>
            <th>Target Temp</th>
            <th>Target Humidity</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr id={`asset-${a.id}`} key={a.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{a.name}</td>
              <td>{a.type}</td>
              <td>{a.targetTemp}</td>
              <td>{a.targetHumidity}</td>
              {/* TODO: pull latest Reading + Alert status per asset once
                  sensor vendor is wired up */}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
