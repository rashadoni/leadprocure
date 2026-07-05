import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AuthProvider, Protected, useAuth } from './auth/auth';
import { I18nProvider } from './i18n';
import Shell from './layouts/Shell';
import Login from './pages/Login';
import Requests from './pages/buyer/Requests';
import Events from './pages/buyer/Events';
import EventDetail from './pages/buyer/EventDetail';
import Suppliers from './pages/buyer/Suppliers';
import Market from './pages/supplier/Market';
import SupplierEvent from './pages/supplier/SupplierEvent';
import './styles.css';

function Home() {
  const { session, loading } = useAuth();
  if (loading) return <div className="center">…</div>;
  if (!session) return <Navigate to="/login" replace />;
  return <Navigate to={session.org.kind === 'SUPPLIER' ? '/supplier/market' : '/buyer/requests'} replace />;
}

const BUYER = ['BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER'];
const SUPPLIER = ['SUPPLIER_USER'];

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/', element: <Home /> },
  {
    element: <Protected><Shell /></Protected>,
    children: [
      { path: '/buyer/requests', element: <Protected roles={BUYER}><Requests /></Protected> },
      { path: '/buyer/events', element: <Protected roles={BUYER}><Events /></Protected> },
      { path: '/buyer/events/:id', element: <Protected roles={BUYER}><EventDetail /></Protected> },
      { path: '/buyer/suppliers', element: <Protected roles={BUYER}><Suppliers /></Protected> },
      { path: '/supplier/market', element: <Protected roles={SUPPLIER}><Market /></Protected> },
      { path: '/supplier/events/:id', element: <Protected roles={SUPPLIER}><SupplierEvent /></Protected> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </I18nProvider>
  </React.StrictMode>,
);
