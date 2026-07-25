import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SourcesPanel from "./SourcesPanel.jsx";

describe("SourcesPanel", () => {
  it("renders page sources separately and expands a longer list", () => {
    const sources = [1, 2, 3].map((page) => ({
      id: `DOC${page}`,
      stableId: `PDF-S${page}`,
      type: "document",
      title: "Clinical notes.pdf",
      page,
      excerpt: `Evidence from page ${page}`,
    }));
    render(
      <SourcesPanel
        sources={sources}
        groundingType="document"
        messageId="answer-1"
      />,
    );
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.queryByText("Page 3")).toBeNull();
    fireEvent.click(screen.getByText("Show 1 more"));
    expect(screen.getByText("Page 3")).toBeTruthy();
  });

  it("uses a subtle label for an ungrounded response", () => {
    render(
      <SourcesPanel
        sources={[]}
        groundingType="general"
        messageId="answer-1"
      />,
    );
    expect(screen.getByText("General educational response")).toBeTruthy();
  });

  it("links dataset records to the real Hugging Face page and shows the verification note", () => {
    render(
      <SourcesPanel
        sources={[
          {
            id: "HF1",
            type: "dataset",
            title: "AI Medical Dataset",
            recordId: "HF-MED-1",
            excerpt: "Supporting context",
            url: "https://huggingface.co/datasets/ruslanmv/ai-medical-dataset",
          },
        ]}
        groundingType="dataset"
        messageId="answer-2"
      />,
    );
    expect(
      screen.getByRole("link", { name: "View dataset" }).getAttribute("href"),
    ).toContain("ruslanmv/ai-medical-dataset");
    expect(
      screen.getByText(/may require professional verification/),
    ).toBeTruthy();
  });
});
