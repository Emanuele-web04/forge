export class MigrationConsentHandoff {
  private pending: string | null = null;

  approve(consentToken: string): void {
    this.pending = consentToken;
  }

  take(): string | null {
    const consentToken = this.pending;
    this.pending = null;
    return consentToken;
  }
}
