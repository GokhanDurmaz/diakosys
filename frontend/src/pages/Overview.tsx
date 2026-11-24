import { useEffect, useState } from 'react';
import { useTasks, useHealth, useExecutions } from '../api/hooks';
import type { Task, TaskState } from '../api/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Link } from 'react-router-dom';
import { LayoutDashboard, ArrowRight, Activity, Database, Clock } from 'lucide-react';
import { cn } from '../theme/hooks';

const taskStateColors: Record<TaskState, string> = {
  DISCOVERING: 'info',
  IN_PROGRESS: 'warning',
  VERIFYING: 'secondary',
  DONE: 'success',
  FAILED: 'destructive',
};

export function OverviewPage() {
  const [healthData, setHealthData] = useState<any>(null);
  const { data: tasksData, isLoading: loadingTasks } = useTasks();
  const { data: executionsData, isLoading: loadingExecutions } = useExecutions();
  const { data: healthDataFromApi } = useHealth();

  useEffect(() => {
    if (healthDataFromApi) {
      setHealthData(healthDataFromApi);
    }
  }, [healthDataFromApi]);

  const stats = {
    totalTasks: tasksData?.total || 0,
    activeTasks: tasksData?.items.filter((t: Task) => 
      t.state !== 'DONE' && t.state !== 'FAILED'
    ).length || 0,
    completedTasks: tasksData?.items.filter((t: Task) => 
      t.state === 'DONE'
    ).length || 0,
    failedTasks: tasksData?.items.filter((t: Task) => 
      t.state === 'FAILED'
    ).length || 0,
  };

  const recentTasks = tasksData?.items.slice(0, 5) || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">
            Monitor your workflow execution and system health
          </p>
        </div>
        <Link to="/backlog">
          <Button>
            View All Tasks
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>

      {/* Health Status Card */}
      <Card>
        <CardHeader>
          <CardDescription>System Health</CardDescription>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {healthData?.healthy ? 'All Systems Operational' : 'System Degraded'}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg bg-muted/50 p-4">
            <div className="text-sm text-muted-foreground">Database</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={healthData?.databaseConnected ? 'success' : 'destructive'}>
                {healthData?.databaseConnected ? 'Connected' : 'Disconnected'}
              </Badge>
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 p-4">
            <div className="text-sm text-muted-foreground">Migrations</div>
            <div className="mt-1 text-2xl font-bold">{healthData?.migrationCount || 0}</div>
          </div>
          <div className="rounded-lg bg-muted/50 p-4">
            <div className="text-sm text-muted-foreground">Uptime</div>
            <div className="mt-1 text-2xl font-bold">{healthData?.uptime || 'N/A'}</div>
          </div>
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Tasks"
          value={stats.totalTasks}
          icon={<LayoutDashboard className="h-4 w-4" />}
          trend="+12% from yesterday"
        />
        <StatCard
          title="Active"
          value={stats.activeTasks}
          icon={<Activity className="h-4 w-4" />}
          variant="warning"
        />
        <StatCard
          title="Completed"
          value={stats.completedTasks}
          icon={<Database className="h-4 w-4" />}
          variant="success"
        />
        <StatCard
          title="Failed"
          value={stats.failedTasks}
          icon={<Clock className="h-4 w-4" />}
          variant="destructive"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Tasks */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardDescription>Recent Tasks</CardDescription>
            <CardTitle>Latest Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingTasks ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="animate-pulse space-y-2">
                    <div className="h-4 w-3/4 bg-muted rounded" />
                    <div className="h-3 w-1/2 bg-muted rounded" />
                  </div>
                ))}
              </div>
            ) : recentTasks.length === 0 ? (
              <EmptyState message="No tasks yet" description="Create your first task to get started" />
            ) : (
              <div className="space-y-3">
                {recentTasks.map((task: Task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Executions Summary */}
        <Card>
          <CardHeader>
            <CardDescription>Executions</CardDescription>
            <CardTitle>Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingExecutions ? (
              <div className="space-y-4">
                {[1, 2].map((i) => (
                  <div key={i} className="animate-pulse space-y-2">
                    <div className="h-4 w-3/4 bg-muted rounded" />
                    <div className="h-3 w-1/2 bg-muted rounded" />
                  </div>
                ))}
              </div>
            ) : executionsData?.length === 0 ? (
              <EmptyState message="No executions yet" description="Run a workflow to see execution history" />
            ) : (
              <div className="space-y-3">
                {executionsData?.slice(0, 5).map((execution: any) => (
                  <div key={execution.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <div className="font-medium">{execution.status}</div>
                      <div className="text-xs text-muted-foreground">{execution.tasksProcessed} tasks</div>
                    </div>
                    <Badge variant={execution.status === 'completed' ? 'success' : 'secondary'}>
                      {execution.duration}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Section */}
      {healthData && (
        <Card>
          <CardHeader>
            <CardDescription>System Metrics</CardDescription>
            <CardTitle>Performance Overview</CardTitle>
          </CardHeader>
          <CardContent>
            {healthData.healthy ? (
              <EmptyState
                message="Insufficient historical data"
                description="Charts will populate as more execution data becomes available"
                action={
                  <Link to="/executions">
                    <Button variant="outline">View Executions</Button>
                  </Link>
                }
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center rounded-lg bg-muted/50">
                <p className="text-muted-foreground">Chart placeholder - data coming soon</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  trend?: string;
  variant?: 'default' | 'warning' | 'success' | 'destructive';
}

function StatCard({ title, value, icon, trend, variant = 'default' }: StatCardProps) {
  const variantClasses = {
    default: 'bg-background',
    warning: 'bg-yellow-500/10 text-yellow-500 dark:bg-yellow-500/20',
    success: 'bg-green-500/10 text-green-500 dark:bg-green-500/20',
    destructive: 'bg-red-500/10 text-red-500 dark:bg-red-500/20',
  } as const;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {trend && <p className="text-xs text-muted-foreground mt-1">{trend}</p>}
          </div>
          <div className={cn('rounded-lg p-3', variantClasses[variant])}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TaskRow({ task }: { task: Task }) {
  const state = task.state as TaskState;
  
  return (
    <div className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent/30 transition-colors cursor-pointer">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{task.title}</div>
        <div className="text-xs text-muted-foreground">
          {new Date(task.createdAt).toLocaleDateString()} • {new Date(task.createdAt).toLocaleTimeString()}
        </div>
      </div>
      <Badge variant={taskStateColors[state] || 'secondary' as any} className="ml-4">
        {state.replace(/_/g, ' ')}
      </Badge>
    </div>
  );
}

function EmptyState({ message, description, action }: { message: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <LayoutDashboard className="h-8 w-8 text-muted-foreground" />
      </div>
      <p className="font-medium">{message}</p>
      {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
