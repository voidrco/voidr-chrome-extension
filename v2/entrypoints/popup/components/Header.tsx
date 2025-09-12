import React from 'react';
import '../popup.css';

type HeaderProps = {
  onSync: () => void;
};

export default function Header({ onSync }: HeaderProps) {
  return (
    <div className="extension-header">
      <div className="logo-container">
        <img src="/assets/logo-light.svg" alt="Voidr Logo" className="logo-icon" />
        <span style={{ fontWeight: 600 }}>Voidr Testing Assistant</span>
      </div>
      <div className="header-right">
        <div id="voidr-org-card" />
        <button className="voidr-action-btn" onClick={onSync} title="Sync now" id="sync-all-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,4 1,10 7,10"></polyline>
            <polyline points="23,20 23,14 17,14"></polyline>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}


