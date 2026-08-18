import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@tanstack/react-query';
import { getProducts } from '../../services/products';

interface ProductSelectProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

export function ProductSelect({ selectedId, onSelect, className }: ProductSelectProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: getProducts,
  });

  const products = Array.isArray(data) ? data : (data?.data || []);

  return (
    <Select value={selectedId || undefined} onValueChange={onSelect}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={isLoading ? "Loading products..." : "Select a product..."} />
      </SelectTrigger>
      <SelectContent>
        {products.map((product: any) => (
          <SelectItem key={product._id} value={product._id}>
            {product.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
