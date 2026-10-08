import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="login">
        <div className="login-brand">SignalDesk</div>
        <section className="form">
          <h1>화면을 표시하지 못했습니다</h1>
          <p>화면을 다시 불러와 주세요. 문제가 반복되면 브라우저 오류와 재현 과정을 확인하세요.</p>
          <button className="button" onClick={() => location.reload()}>
            다시 불러오기
          </button>
        </section>
      </div>
    ) : (
      this.props.children
    );
  }
}
