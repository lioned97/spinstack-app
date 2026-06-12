// Paywalled-publisher detection: when a paper has no open-access PDF
// but lives on one of these hosts, the institutional proxy (EZproxy)
// is the right way in — credentials stay with the university, never
// the app.

const PAYWALLED = [
  "nature.com",
  "science.org",
  "cell.com",
  "wiley.com",
  "springer.com",
  "springerlink.com",
  "link.springer.com",
  "sciencedirect.com",
  "elsevier.com",
  "tandfonline.com",
  "oup.com",
  "academic.oup.com",
  "pubs.acs.org",
  "rsc.org",
  "annualreviews.org",
  "physicstoday.org",
  "iopscience.iop.org",
  "aps.org",
  "journals.aps.org",
  "doi.org", // DOI links resolve to the publisher — proxy handles the redirect
];

export const isPaywalled = (p) => {
  try {
    const host = new URL(p.url || p.pdf || "").hostname.replace("www.", "");
    return PAYWALLED.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
};

export const proxyUrl = (proxy, url) => proxy + encodeURIComponent(url);
