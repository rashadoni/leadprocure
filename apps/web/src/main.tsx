import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AuthProvider, Protected, useAuth } from './auth/auth';
import { I18nProvider } from './i18n';
import Shell from './layouts/Shell';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/buyer/Dashboard';
import Settings from './pages/buyer/Settings';
import Logistics from './pages/buyer/Logistics';
import Catalogs from './pages/buyer/Catalogs';
import Verification from './pages/Verification';
import Invoices from './pages/Invoices';
import Contracts from './pages/buyer/Contracts';
import Orders from './pages/supplier/Orders';
import SupplierDashboard from './pages/supplier/Dashboard';
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
  return <Navigate to={session.org.kind === 'SUPPLIER' ? '/supplier/dashboard' : '/buyer/requests'} replace />;
}

const BUYER = ['BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER'];
const SUPPLIER = ['SUPPLIER_USER'];

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/reset', element: <ResetPassword /> },
  { path: '/', element: <Home /> },
  {
    element: <Protected><Shell /></Protected>,
    children: [
      { path: '/buyer/dashboard', element: <Protected roles={BUYER}><Dashboard /></Protected> },
      { path: '/buyer/settings', element: <Protected roles={BUYER}><Settings /></Protected> },
      { path: '/buyer/logistics', element: <Protected roles={BUYER}><Logistics /></Protected> },
      { path: '/buyer/catalogs', element: <Protected roles={BUYER}><Catalogs /></Protected> },
      { path: '/supplier/catalogs', element: <Protected roles={SUPPLIER}><Catalogs /></Protected> },
      { path: '/buyer/verification', element: <Protected roles={BUYER}><Verification /></Protected> },
      { path: '/supplier/verification', element: <Protected roles={SUPPLIER}><Verification /></Protected> },
      { path: '/buyer/invoices', element: <Protected roles={BUYER}><Invoices /></Protected> },
      { path: '/supplier/invoices', element: <Protected roles={SUPPLIER}><Invoices /></Protected> },
      { path: '/buyer/contracts', element: <Protected roles={BUYER}><Contracts /></Protected> },
      { path: '/supplier/orders', element: <Protected roles={SUPPLIER}><Orders /></Protected> },
      { path: '/supplier/contracts', element: <Protected roles={SUPPLIER}><Contracts /></Protected> },
      { path: '/buyer/requests', element: <Protected roles={BUYER}><Requests /></Protected> },
      { path: '/buyer/events', element: <Protected roles={BUYER}><Events /></Protected> },
      { path: '/buyer/events/:id', element: <Protected roles={BUYER}><EventDetail /></Protected> },
      { path: '/buyer/suppliers', element: <Protected roles={BUYER}><Suppliers /></Protected> },
      { path: '/supplier/dashboard', element: <Protected roles={SUPPLIER}><SupplierDashboard /></Protected> },
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
