import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

type ViewBoundaryProps = {
  children: ReactNode;
  /** When this changes, a failed boundary forgets the failure and renders its children again. */
  resetKey: string;
  /** Present only where the view covers the screen (the player): adds a Close button. */
  onClose?: () => void;
  /** Overridable for tests; defaults to window.location.reload(). */
  reload?: () => void;
};

type ViewBoundaryState = { failed: boolean; key: string };

export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = { failed: false, key: this.props.resetKey };
  private readonly retryButton = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): Pick<ViewBoundaryState, "failed"> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ViewBoundaryProps, state: ViewBoundaryState): ViewBoundaryState | null {
    if (props.resetKey !== state.key) return { failed: false, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("view crashed", error, info.componentStack);
  }

  componentDidMount(): void {
    if (this.state.failed) this.retryButton.current?.focus();
  }

  componentDidUpdate(_props: ViewBoundaryProps, previous: ViewBoundaryState): void {
    if (this.state.failed && !previous.failed) this.retryButton.current?.focus();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className={`view-error${this.props.onClose ? " view-error-overlay" : ""}`} role="alert">
      <p>{t("viewError.message")}</p>
      <div className="view-error-actions">
        <button type="button" ref={this.retryButton} onClick={() => this.setState({ failed: false })}>{t("common.retry")}</button>
        <button type="button" onClick={() => (this.props.reload ?? (() => window.location.reload()))()}>{t("viewError.reload")}</button>
        {this.props.onClose && <button type="button" onClick={this.props.onClose}>{t("common.close")}</button>}
      </div>
    </div>;
  }
}
