import { useState } from 'react';
import { useCompetitors, useCreateCompetitor, useUpdateCompetitor, useDeleteCompetitor } from '../../hooks/useCompetitors';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Trash2, Edit2, ExternalLink, Activity, Sparkles, Loader2 } from 'lucide-react';
import type { Competitor } from '../../services/competitors';
import { api } from '../../services/api';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  productId: string;
}

export function CompetitorManagement({ productId }: Props) {
  const { data: competitors, isLoading } = useCompetitors(productId);
  const createMutation = useCreateCompetitor();
  const updateMutation = useUpdateCompetitor();
  const deleteMutation = useDeleteCompetitor();
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isAutoDiscovering, setIsAutoDiscovering] = useState(false);
  const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(null);
  
  const [formData, setFormData] = useState<Partial<Competitor>>({
    name: '',
    type: 'direct',
    url: '',
    wpOrgSlug: '',
    rssFeedUrl: '',
    status: 'active'
  });

  const handleOpenDialog = (competitor?: Competitor) => {
    if (competitor) {
      setEditingCompetitor(competitor);
      setFormData(competitor);
    } else {
      setEditingCompetitor(null);
      setFormData({
        name: '',
        type: 'direct',
        url: '',
        wpOrgSlug: '',
        rssFeedUrl: '',
        status: 'active'
      });
    }
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    if (!formData.name) {
      toast.error('Competitor name is required');
      return;
    }

    const payload = { ...formData };
    
    if (editingCompetitor) {
      updateMutation.mutate(
        { productId, competitorId: editingCompetitor._id, payload },
        {
          onSuccess: () => {
            toast.success('Competitor updated');
            setIsDialogOpen(false);
          },
          onError: () => toast.error('Failed to update competitor')
        }
      );
    } else {
      createMutation.mutate(
        { productId, payload },
        {
          onSuccess: () => {
            toast.success('Competitor added');
            setIsDialogOpen(false);
          },
          onError: () => toast.error('Failed to add competitor')
        }
      );
    }
  };

  const handleDelete = (competitorId: string) => {
    if (confirm('Are you sure you want to remove this competitor?')) {
      deleteMutation.mutate(
        { productId, competitorId },
        {
          onSuccess: () => toast.success('Competitor removed'),
          onError: () => toast.error('Failed to remove competitor')
        }
      );
    }
  };

  const handleAutoDiscover = async () => {
    try {
      setIsAutoDiscovering(true);
      await api.post(`/competitors/${productId}/auto-discover`);
      toast.success('Competitors auto-discovered successfully!');
      queryClient.invalidateQueries({ queryKey: ['competitors', productId] });
    } catch (error) {
      console.error('Auto-discover failed:', error);
      toast.error('Failed to auto-discover competitors.');
    } finally {
      setIsAutoDiscovering(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Competitors</CardTitle>
          <CardDescription>Track and analyze your competition.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleAutoDiscover} disabled={isAutoDiscovering} variant="secondary" className="gap-2 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/40">
            {isAutoDiscovering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} 
            Auto-Discover (AI)
          </Button>
          <Button onClick={() => handleOpenDialog()} className="gap-2">
            <Plus className="w-4 h-4" /> Add Competitor
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="animate-pulse space-y-4">
            <div className="h-12 bg-slate-100 dark:bg-slate-800 rounded"></div>
            <div className="h-12 bg-slate-100 dark:bg-slate-800 rounded"></div>
          </div>
        ) : competitors?.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            No competitors added yet. Click "Add Competitor" to start tracking.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {competitors?.map((competitor) => (
              <Card key={competitor._id} className="overflow-hidden relative group">
                <div className={`absolute top-0 left-0 w-1 h-full ${
                  competitor.type === 'direct' ? 'bg-red-500' : 
                  competitor.type === 'indirect' ? 'bg-orange-400' : 'bg-blue-400'
                }`} />
                <CardContent className="p-5 pl-6 flex flex-col h-full justify-between">
                  <div>
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-semibold text-lg">{competitor.name}</h3>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenDialog(competitor)}>
                          <Edit2 className="w-3.5 h-3.5 text-slate-500" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(competitor._id)}>
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      </div>
                    </div>
                    <span className="inline-block px-2 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs rounded-full mb-3 capitalize">
                      {competitor.type} Competitor
                    </span>
                    
                    <div className="space-y-1 text-sm text-slate-500">
                      {competitor.url && (
                        <a href={competitor.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-indigo-500 transition-colors">
                          <ExternalLink className="w-3.5 h-3.5" /> Website
                        </a>
                      )}
                      {competitor.wpOrgSlug && (
                        <div className="flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5" /> WP.org Sync Enabled
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCompetitor ? 'Edit Competitor' : 'Add Competitor'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name <span className="text-red-500">*</span></label>
                <Input 
                  placeholder="e.g. Acme Corp" 
                  value={formData.name || ''} 
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-medium">Type</label>
                <Select value={formData.type} onValueChange={(val: any) => setFormData({ ...formData, type: val })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct">Direct Competitor (Same Audience & Problem)</SelectItem>
                    <SelectItem value="indirect">Indirect Competitor (Different Audience or Problem)</SelectItem>
                    <SelectItem value="alternative">Alternative (Different approach)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Website URL</label>
                <Input 
                  placeholder="https://" 
                  value={formData.url || ''} 
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">WordPress.org Slug (Optional)</label>
                <Input 
                  placeholder="e.g. acme-seo" 
                  value={formData.wpOrgSlug || ''} 
                  onChange={(e) => setFormData({ ...formData, wpOrgSlug: e.target.value })}
                />
                <p className="text-xs text-slate-500">Enable automatic tracking of active installs and ratings.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Changelog RSS Feed (Optional)</label>
                <Input 
                  placeholder="https://acme.com/feed" 
                  value={formData.rssFeedUrl || ''} 
                  onChange={(e) => setFormData({ ...formData, rssFeedUrl: e.target.value })}
                />
                <p className="text-xs text-slate-500">Enable automatic tracking of new features and updates.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
                Save Competitor
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
