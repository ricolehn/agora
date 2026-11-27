// The part of html2pdf.js the finance report uses (the package brings no types)
declare module 'html2pdf.js' {
  interface Html2PdfWorker {
    set(options: Record<string, unknown>): Html2PdfWorker;
    from(element: HTMLElement): Html2PdfWorker;
    save(): Promise<void>;
  }
  export default function html2pdf(): Html2PdfWorker;
}
