# pdfpatches

## Common Scripts

- do_fetch: Downloads the PDF using wget and verifies its checksum.
- do_clean: Cleans the downloaded PDF using mutool to prepare it for patching.
- do_patch: Applies all patch files from the patches directory to the cleaned PDF.
- do_optimize: Compresses and optimizes the final PDF.
