
module Enterprise
  module Billing
    class InvoiceProcessor
      attr_reader :invoices, :processed_count

      def initialize
        @invoices = []
        @processed_count = 0
      end

      def add_invoice(id, amount, customer_id)
        @invoices << {
          id: id,
          amount: amount,
          customer_id: customer_id,
          status: :pending,
          created_at: Time.now
        }
      end

      def process_pending
        @invoices.each do |invoice|
          next unless invoice[:status] == :pending

          begin
            charge_customer(invoice[:customer_id], invoice[:amount])
            invoice[:status] = :paid
            @processed_count += 1
          rescue => e
            puts "Failed to process invoice #{invoice[:id]}: #{e.message}"
            invoice[:status] = :failed
          end
        end
      end

      def report
        paid = @invoices.select { |i| i[:status] == :paid }.sum { |i| i[:amount] }
        failed = @invoices.select { |i| i[:status] == :failed }.count
        { total_paid: paid, failed_count: failed, processed: @processed_count }
      end

      private

      def charge_customer(customer_id, amount)
        raise "Invalid amount" if amount <= 0
        sleep 0.1 
      end
    end
  end
end
