import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { clearToken, getToken, getUser, isAdmin } from './api';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import ProjectsPage from './pages/ProjectsPage';
import IssuesPage from './pages/IssuesPage';
import IssueDetailPage from './pages/IssueDetailPage';
import SettingsPage from './pages/SettingsPage';
import UsersPage from './pages/UsersPage';

function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const user = getUser();
  if (!getToken()) return <Navigate to="/login" replace />;
  return (
    <>
      <div className="topbar">
        <Link to="/" className="logo">
          look<span>out</span>
        </Link>
        <div className="spacer" />
        {isAdmin() && <Link to="/users">Members</Link>}
        <span className="dim">{user?.name}</span>
        <button
          className="secondary"
          onClick={() => {
            clearToken();
            navigate('/login');
          }}
        >
          Log out
        </button>
      </div>
      <div className="container">{children}</div>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={<Shell><ProjectsPage /></Shell>} />
      <Route path="/projects/:projectId" element={<Shell><IssuesPage /></Shell>} />
      <Route path="/projects/:projectId/settings" element={<Shell><SettingsPage /></Shell>} />
      <Route path="/issues/:issueId" element={<Shell><IssueDetailPage /></Shell>} />
      <Route path="/users" element={<Shell><UsersPage /></Shell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
