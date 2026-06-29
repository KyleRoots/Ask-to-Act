import { Router, Route, Switch } from "wouter";
import ExecSummary from "@/pages/ExecSummary";
import CustomerBrief from "@/pages/CustomerBrief";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function App() {
  return (
    <Router base={base}>
      <Switch>
        <Route path="/customer" component={CustomerBrief} />
        <Route component={ExecSummary} />
      </Switch>
    </Router>
  );
}
