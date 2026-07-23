// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkHeadingId from "remark-heading-id";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  site: "https://tgerke.github.io",
  base: "/edc-core",
  markdown: {
    remarkPlugins: [remarkHeadingId],
  },
  integrations: [
    starlight({
      title: "edc-core",
      description: "A modern, open-source Electronic Data Capture system for clinical research",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/tgerke/edc-core" }],
      customCss: ["./src/styles/custom.css"],
      components: {
        Footer: "./src/components/Footer.astro",
      },
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false })],
      sidebar: [
        {
          label: "Getting started",
          items: ["start-here", "installation", "deployment", "tour"],
        },
        {
          label: "Building studies",
          items: [
            "guide/why-protocol-first",
            "guide/protocol-import",
            "guide/study-builds",
            "guide/rules-and-derivations",
            "guide/site-forms",
            "guide/amendments",
          ],
        },
        {
          label: "Capturing data",
          items: [
            "guide/data-capture",
            "guide/lab-import",
            "guide/rtsm-integration",
            "guide/blinding",
          ],
        },
        {
          label: "Review and oversight",
          items: [
            "guide/review",
            "guide/medical-coding",
            "guide/notifications",
            "guide/user-admin",
          ],
        },
        {
          label: "Analytics and exports",
          items: ["guide/analytics", "guide/exports-and-archive"],
        },
        {
          label: "Architecture and compliance",
          items: ["data-lifecycle", "compliance"],
        },
        {
          label: "Reference",
          items: ["glossary"],
        },
      ],
    }),
  ],
});
