# BigDogOffice CLI

The CLI creates, reads, edits, converts and renders Office documents with the same local engines as the desktop. Its bundle is produced by `npm run build -w @genoffice/cli` and included in desktop packages.

```sh
bigdogoffice --version
bigdogoffice info report.docx --json
bigdogoffice docs read report.docx --full --json
bigdogoffice sheet read budget.xlsx --range A1:D20 --json
bigdogoffice slides read proposal.pptx --full --json
bigdogoffice guide docs
bigdogoffice guide sheets
bigdogoffice guide slides design
```

Use the supported guide before authoring operations. The bundled [Skill](../../skills/bigdogoffice/SKILL.md) describes the presentation pipeline and file rules. Source operations are local; optional cloud search/media features use the configured provider. CLI access and approvals are separate from the in-app Agent.

An editor-owned open file cannot be overwritten with an independent stale CLI model. Save/close the editor or choose another output. Source builds can select an isolated profile using `GENOFFICE_USER_DATA`; local app export uses the built desktop runtime.
